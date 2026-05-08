/* global chrome */
import {
    focusReusableTab,
    isTabReuseEnabled,
    findReusableTab,
    normalizeReusableUrl,
    getReuseDomainKey,
    getReuseDomainPolicy,
    setReuseDomainPolicy
} from "./api/tabReuse";
import { BUILTIN_TOOL_NAMES, executeTool } from "./api/llm";
import { connectWsBridge, disconnectWsBridge, ensureWsBridgeHealthy, getWsBridgeStatus, startWsBridge } from "./api/wsBridge";
import {
    listMacros,
    saveMacro,
    deleteMacro,
    getMacro,
    getRecording,
    setRecording,
    clearRecording,
    newMacroId,
    normalizeStep
} from "./api/macro";

const REUSE_PROMPT_TIMEOUT_MS = 30000;
const pendingReusePrompts = new Map();
const SCHEDULE_STORAGE_KEY = "scheduledJobs";
const SCHEDULE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
const SCHEDULE_FIRE_ALARM_PREFIX = "schedule-fire:";
const SCHEDULE_CLEANUP_ALARM_PREFIX = "schedule-cleanup:";
const TERMINAL_SCHEDULE_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const PASSWORD_PLACEHOLDER = "1A2b3!4399";

function buildScheduleFireAlarmName(id) {
    return `${SCHEDULE_FIRE_ALARM_PREFIX}${id}`;
}

function buildScheduleCleanupAlarmName(id) {
    return `${SCHEDULE_CLEANUP_ALARM_PREFIX}${id}`;
}

function isTerminalScheduleStatus(status) {
    return TERMINAL_SCHEDULE_STATUSES.has(status);
}

async function loadScheduledJobs() {
    const { [SCHEDULE_STORAGE_KEY]: jobs } = await chrome.storage.local.get({ [SCHEDULE_STORAGE_KEY]: [] });
    return Array.isArray(jobs) ? jobs : [];
}

async function saveScheduledJobs(jobs) {
    await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: jobs });
}

function serializeScheduledJob(job) {
    const remainingSeconds = job.status === "pending"
        ? Math.max(0, Math.round((job.fireTimestamp - Date.now()) / 1000))
        : 0;
    return {
        id: job.id,
        scheduleId: job.id,
        label: job.label,
        toolName: job.toolName,
        toolArgs: job.toolArgs,
        fireAt: new Date(job.fireTimestamp).toLocaleString(),
        status: job.status,
        remainingSeconds,
        timeoutSeconds: Math.round((job.executeTimeoutMs || (DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS * 1000)) / 1000),
        startedAt: job.startedAt ? new Date(job.startedAt).toLocaleString() : null,
        finishedAt: job.finishedAt ? new Date(job.finishedAt).toLocaleString() : null,
        error: job.error || null,
        expiresAt: job.expiresAt ? new Date(job.expiresAt).toLocaleString() : null
    };
}

async function clearScheduleAlarms(scheduleId) {
    if (!chrome.alarms) return;
    await chrome.alarms.clear(buildScheduleFireAlarmName(scheduleId));
    await chrome.alarms.clear(buildScheduleCleanupAlarmName(scheduleId));
}

async function createScheduleFireAlarm(job) {
    if (!chrome.alarms || job.status !== "pending") return;
    await chrome.alarms.create(buildScheduleFireAlarmName(job.id), { when: Math.max(Date.now(), job.fireTimestamp) });
}

async function createScheduleCleanupAlarm(job) {
    if (!chrome.alarms || !isTerminalScheduleStatus(job.status) || !Number.isFinite(job.expiresAt)) return;
    await chrome.alarms.create(buildScheduleCleanupAlarmName(job.id), { when: Math.max(Date.now(), job.expiresAt) });
}

async function pruneExpiredScheduledJobs() {
    const jobs = await loadScheduledJobs();
    const now = Date.now();
    const kept = [];
    for (const job of jobs) {
        if (isTerminalScheduleStatus(job?.status) && Number.isFinite(job?.expiresAt) && job.expiresAt <= now) {
            await clearScheduleAlarms(job.id);
            continue;
        }
        kept.push(job);
    }
    if (kept.length !== jobs.length) {
        await saveScheduledJobs(kept);
    }
    return kept;
}

function buildScheduleMcpSnapshot(mcpRegistry = []) {
    return (mcpRegistry || []).map(tool => ({
        name: tool?.name,
        _serverName: tool?._serverName,
        _serverUrl: tool?._serverUrl,
        _serverHeaders: tool?._serverHeaders || {},
        _toolCallName: tool?._toolCallName
    })).filter(tool => tool.name && tool._toolCallName && tool._serverUrl);
}

function isKnownScheduledToolName(toolName, mcpRegistry = []) {
    if (BUILTIN_TOOL_NAMES.includes(toolName)) return true;
    return (mcpRegistry || []).some(tool => tool?._toolCallName === toolName);
}

async function executeToolWithTimeout(name, args, mcpRegistry, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await executeTool(name, args, mcpRegistry);
    }
    return await Promise.race([
        executeTool(name, args, mcpRegistry),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Tool execution timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        })
    ]);
}

async function listScheduledJobs() {
    const jobs = await pruneExpiredScheduledJobs();
    if (jobs.length === 0) {
        return { scheduled: [], message: "No scheduled tasks" };
    }
    return {
        scheduled: jobs
            .slice()
            .sort((a, b) => b.fireTimestamp - a.fireTimestamp)
            .map(serializeScheduledJob)
    };
}

async function clearCompletedScheduledJobs() {
    const jobs = await pruneExpiredScheduledJobs();
    const completedJobs = jobs.filter(job => isTerminalScheduleStatus(job?.status));
    if (completedJobs.length === 0) {
        return { success: true, removedCount: 0, removedIds: [] };
    }

    const kept = jobs.filter(job => !isTerminalScheduleStatus(job?.status));
    await saveScheduledJobs(kept);

    for (const job of completedJobs) {
        await clearScheduleAlarms(job.id);
    }

    return {
        success: true,
        removedCount: completedJobs.length,
        removedIds: completedJobs.map(job => job.id)
    };
}

async function scheduleJob(payload = {}) {
    const { delaySeconds, timestamp, toolName, toolArgs, label, timeoutSeconds, mcpRegistry } = payload;
    const mcpSnapshot = buildScheduleMcpSnapshot(mcpRegistry);

    if (!isKnownScheduledToolName(toolName, mcpSnapshot)) {
        return { error: `Unknown tool: ${toolName}` };
    }
    if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
        return { error: "toolArgs is required and must be an object" };
    }

    const now = Date.now();
    let delayMs;
    let fireTimestamp;

    if (delaySeconds != null && Number(delaySeconds) > 0) {
        delayMs = Number(delaySeconds) * 1000;
        fireTimestamp = now + delayMs;
    } else if (timestamp != null && Number.isFinite(Number(timestamp))) {
        fireTimestamp = Number(timestamp);
        delayMs = fireTimestamp - now;
    } else {
        return { error: "Please provide either delaySeconds or timestamp" };
    }

    if (delayMs < 0) return { error: "The specified time is in the past" };

    const jobs = await pruneExpiredScheduledJobs();
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const executeTimeoutMs = Math.max(1, Number(timeoutSeconds) || DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS) * 1000;
    const entry = {
        id,
        fireTimestamp,
        toolName,
        toolArgs,
        label: label || toolName,
        executeTimeoutMs,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        error: null,
        expiresAt: null,
        mcpRegistry: mcpSnapshot
    };

    jobs.push(entry);
    await saveScheduledJobs(jobs);
    await createScheduleFireAlarm(entry);

    return {
        success: true,
        scheduleId: id,
        toolName,
        toolArgs,
        label: entry.label,
        fireAt: new Date(fireTimestamp).toLocaleString(),
        delaySeconds: Math.round(delayMs / 1000),
        timeoutSeconds: Math.round(executeTimeoutMs / 1000)
    };
}

async function cancelScheduledJob(scheduleId) {
    const jobs = await pruneExpiredScheduledJobs();
    const index = jobs.findIndex(job => job.id === scheduleId);
    if (index < 0) return { error: `Schedule not found: ${scheduleId}` };

    const cancelled = jobs[index];
    if (cancelled.status !== "pending") {
        return { error: `Schedule ${scheduleId} is already ${cancelled.status}` };
    }

    cancelled.status = "cancelled";
    cancelled.finishedAt = Date.now();
    cancelled.error = null;
    cancelled.expiresAt = cancelled.finishedAt + SCHEDULE_RETENTION_MS;
    await saveScheduledJobs(jobs);
    await clearScheduleAlarms(cancelled.id);
    await createScheduleCleanupAlarm(cancelled);

    return {
        success: true,
        cancelled: {
            scheduleId: cancelled.id,
            label: cancelled.label,
            toolName: cancelled.toolName,
            wasScheduledFor: new Date(cancelled.fireTimestamp).toLocaleString(),
            status: cancelled.status,
            expiresAt: new Date(cancelled.expiresAt).toLocaleString()
        }
    };
}

async function finalizeScheduledJob(scheduleId, updater) {
    const jobs = await pruneExpiredScheduledJobs();
    const index = jobs.findIndex(job => job.id === scheduleId);
    if (index < 0) return null;
    const job = jobs[index];
    updater(job);
    await saveScheduledJobs(jobs);
    return job;
}

async function runScheduledJob(scheduleId) {
    const jobs = await pruneExpiredScheduledJobs();
    const index = jobs.findIndex(job => job.id === scheduleId);
    if (index < 0) return;

    const job = jobs[index];
    if (job.status !== "pending") return;

    job.status = "running";
    job.startedAt = Date.now();
    job.error = null;
    await saveScheduledJobs(jobs);
    await chrome.alarms?.clear(buildScheduleFireAlarmName(scheduleId));

    let nextStatus = "succeeded";
    let errorText = null;
    try {
        const result = await executeToolWithTimeout(job.toolName, job.toolArgs, job.mcpRegistry || [], job.executeTimeoutMs);
        if (result && typeof result === "object" && !Array.isArray(result) && result.error) {
            nextStatus = "failed";
            errorText = String(result.error);
        }
    } catch (error) {
        nextStatus = "failed";
        errorText = error?.message || String(error);
    }

    const finishedAt = Date.now();
    const updatedJob = await finalizeScheduledJob(scheduleId, (current) => {
        current.status = nextStatus;
        current.finishedAt = finishedAt;
        current.error = errorText;
        current.expiresAt = finishedAt + SCHEDULE_RETENTION_MS;
    });
    if (updatedJob) {
        await createScheduleCleanupAlarm(updatedJob);
    }
}

async function cleanupScheduledJob(scheduleId) {
    const jobs = await loadScheduledJobs();
    const kept = jobs.filter(job => job.id !== scheduleId);
    if (kept.length === jobs.length) return;
    await saveScheduledJobs(kept);
    await clearScheduleAlarms(scheduleId);
}

async function restoreScheduledJobs() {
    const jobs = await pruneExpiredScheduledJobs();
    let changed = false;
    for (const job of jobs) {
        if (job.status === "running") {
            job.status = "failed";
            job.finishedAt = Date.now();
            job.error = job.error || "Background worker restarted before the scheduled job completed";
            job.expiresAt = job.finishedAt + SCHEDULE_RETENTION_MS;
            changed = true;
        }
    }
    if (changed) {
        await saveScheduledJobs(jobs);
    }

    for (const job of jobs) {
        if (job.status === "pending") {
            if (job.fireTimestamp <= Date.now()) {
                await runScheduledJob(job.id);
            } else {
                await createScheduleFireAlarm(job);
            }
        } else if (isTerminalScheduleStatus(job.status) && Number.isFinite(job.expiresAt)) {
            await createScheduleCleanupAlarm(job);
        }
    }
}

function clearPendingReusePrompt(tabId) {
    const pending = pendingReusePrompts.get(tabId);
    if (!pending) return null;
    clearTimeout(pending.timeoutId);
    pendingReusePrompts.delete(tabId);
    return pending;
}

async function closeTabIfExists(tabId) {
    if (!tabId) return;
    try {
        await chrome.tabs.remove(tabId);
    } catch (_error) {
        // Ignore missing/already closed tabs.
    }
}

async function getTabIfExists(tabId) {
    if (!tabId) return null;
    try {
        return await chrome.tabs.get(tabId);
    } catch (_error) {
        return null;
    }
}

async function focusTabIfExists(tabId) {
    const tab = await getTabIfExists(tabId);
    if (!tab?.id || !tab.windowId) return null;
    await chrome.windows.update(tab.windowId, { focused: true });
    return await chrome.tabs.update(tab.id, { active: true });
}

async function tryShowReusePrompt(tabId, payload) {
    return await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            if (!response?.success) {
                resolve({ success: false, error: response?.error || "Prompt not acknowledged" });
                return;
            }
            resolve({ success: true });
        });
    });
}

async function applyReuseDecision(pending, decision, rememberChoice) {
    const normalizedDecision = decision === "keep" ? "keep" : "reuse";

    if (rememberChoice && pending.domainKey) {
        await setReuseDomainPolicy(pending.domainKey, normalizedDecision);
    }

    if (normalizedDecision === "reuse") {
        await focusTabIfExists(pending.existingTabId);
        await closeTabIfExists(pending.newTabId);
        return;
    }

    await focusTabIfExists(pending.newTabId);
}

// ========== Macro recording / replay helpers ==========

async function startMacroRecording(payload) {
    const tabId = Number(payload?.tabId);
    const startUrl = String(payload?.startUrl || "").trim();
    const name = String(payload?.name || "").trim() || "untitled";
    if (!Number.isInteger(tabId)) return { success: false, error: "tabId is required" };
    if (!startUrl) return { success: false, error: "startUrl is required" };

    const id = newMacroId();
    let origin = "";
    try { origin = new URL(startUrl).origin; } catch { /* ignore */ }
    const draft = {
        id,
        name,
        startUrl,
        origin,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        steps: []
    };
    await setRecording({ tabId, draft });
    // Nudge the content script in that tab in case it loaded before storage was set.
    try {
        chrome.tabs.sendMessage(tabId, { type: "macro_activate_check" }, () => void chrome.runtime.lastError);
    } catch { /* ignore */ }
    return { success: true, data: { id, tabId } };
}

async function appendMacroDraftStep(rawStep) {
    const recording = await getRecording();
    if (!recording) return;
    const step = normalizeStep(rawStep);
    if (!step) return;
    const draft = recording.draft || { steps: [] };
    draft.steps = Array.isArray(draft.steps) ? draft.steps : [];
    const last = draft.steps[draft.steps.length - 1];
    const sameFirstSelector = (last?.selectors?.[0] || "") && last?.selectors?.[0] === step.selectors?.[0];
    if (last?.type === "input" && step.type === "input" && sameFirstSelector) {
        draft.steps[draft.steps.length - 1] = step;
    } else if (last?.type === "scroll" && step.type === "scroll") {
        draft.steps[draft.steps.length - 1] = step;
    } else if (last?.type === "click" && step.type === "submit") {
        draft.steps[draft.steps.length - 1] = step;
    } else if (last?.type === "wait_url" && step.type === "wait_url" && (last.pattern || last.url) === (step.pattern || step.url)) {
        draft.steps[draft.steps.length - 1] = step;
    } else {
        draft.steps.push(step);
    }
    draft.updatedAt = Date.now();
    await setRecording({ tabId: recording.tabId, draft });
}

async function replaceLastMacroDraftStep(rawStep) {
    const recording = await getRecording();
    if (!recording) return;
    const step = normalizeStep(rawStep);
    if (!step) return;
    const draft = recording.draft || { steps: [] };
    draft.steps = Array.isArray(draft.steps) ? draft.steps : [];
    const last = draft.steps[draft.steps.length - 1];
    const sameFirstSelector = (last?.selectors?.[0] || "") && last?.selectors?.[0] === step.selectors?.[0];
    if (draft.steps.length === 0) {
        draft.steps.push(step);
    } else if (last?.type === step.type && sameFirstSelector) {
        draft.steps[draft.steps.length - 1] = step;
    } else {
        draft.steps.push(step);
    }
    draft.updatedAt = Date.now();
    await setRecording({ tabId: recording.tabId, draft });
}

async function stopMacroRecording({ commit, replacePasswords } = {}) {
    const recording = await getRecording();
    if (!recording) {
        return { success: true, data: { committed: false, reason: "no active recording" } };
    }
    const tabId = recording.tabId;
    const draft = recording.draft;
    await clearRecording();
    // Tell the recorder in that tab to stop (storage change triggers it too).
    try {
        chrome.tabs.sendMessage(tabId, { type: "macro_activate_check" }, () => void chrome.runtime.lastError);
    } catch { /* ignore */ }

    if (!commit) {
        return { success: true, data: { committed: false, discarded: true } };
    }
    if (!draft || !Array.isArray(draft.steps) || draft.steps.length === 0) {
        return { success: true, data: { committed: false, reason: "draft is empty" } };
    }
    const saved = await saveMacro(processMacroBeforeSave(draft, { replacePasswords: replacePasswords === true }));
    return { success: true, data: { committed: true, macro: saved } };
}

function processMacroBeforeSave(macro, { replacePasswords = false } = {}) {
    if (!macro || !Array.isArray(macro.steps)) return macro;
    return {
        ...macro,
        steps: macro.steps.map((step, index) => {
            if (step?.type !== "input" || step.inputType !== "password") return step;
            const key = step.valueRef || `input_${index + 1}`;
            return {
                ...step,
                sensitive: true,
                required: true,
                valueRef: key,
                label: step.label || "password",
                value: replacePasswords ? PASSWORD_PLACEHOLDER : step.value
            };
        })
    };
}

function getMacroInputDescriptors(macro) {
    const inputs = [];
    let ordinal = 0;
    for (let index = 0; index < (macro?.steps || []).length; index++) {
        const step = macro.steps[index];
        if (step?.type !== "input" && step?.type !== "change") continue;
        ordinal += 1;
        const key = step.valueRef || `input_${ordinal}`;
        inputs.push({
            key,
            index: ordinal,
            stepIndex: index,
            stepType: step.type,
            inputKind: step.inputKind || step.tagName || "",
            inputType: step.inputType || "",
            label: step.label || step.text || step.selectors?.[0] || key,
            sensitive: step.sensitive === true,
            required: step.required === true,
            defaultValue: step.sensitive ? undefined : step.value,
            hasDefault: step.value !== undefined,
            selector: step.selectors?.[0] || ""
        });
    }
    return inputs;
}

function describeMacroForTool(macro, { includeSteps = true } = {}) {
    if (!macro) return null;
    return {
        id: macro.id,
        name: macro.name,
        startUrl: macro.startUrl,
        origin: macro.origin,
        stepCount: macro.steps?.length || 0,
        inputs: getMacroInputDescriptors(macro),
        ...(includeSteps ? {
            steps: (macro.steps || []).map((step, index) => ({
                index,
                type: step.type,
                label: step.label || step.text || step.key || step.pattern || step.url || step.selectors?.[0] || "",
                inputKey: (step.type === "input" || step.type === "change")
                    ? (step.valueRef || `input_${getMacroInputDescriptors({ steps: macro.steps.slice(0, index + 1) }).length}`)
                    : undefined,
                sensitive: step.sensitive === true
            }))
        } : {})
    };
}

function applyMacroInputValues(macro, inputValues = {}) {
    let ordinal = 0;
    return {
        ...macro,
        steps: (macro.steps || []).map(step => {
            if (step?.type !== "input" && step?.type !== "change") return step;
            ordinal += 1;
            const key = step.valueRef || `input_${ordinal}`;
            if (!Object.prototype.hasOwnProperty.call(inputValues || {}, key)) return step;
            return { ...step, value: String(inputValues[key] ?? "") };
        })
    };
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) return resolve(false);
                if (tab.status === "complete") return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(check, 200);
            });
        };
        check();
    });
}

function waitForTabUrl(tabId, pattern, timeoutMs = 10000) {
    const matches = (url) => {
        const p = String(pattern || "").trim();
        if (!p) return true;
        if (url === p || String(url || "").includes(p)) return true;
        try { return new RegExp(p).test(String(url || "")); } catch { return false; }
    };
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) return resolve(false);
                if (matches(tab.url)) return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(check, 150);
            });
        };
        check();
    });
}

function sendMacroPlayToTab(tabId, steps, options = {}) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "macro_play", steps, options }, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response || { success: false, error: "empty response" });
        });
    });
}

function normalizeReplayOptions(options = {}) {
    const rawSpeed = String(options.speed || "normal");
    const presets = {
        slow: { stepDelayMs: 1500, highlightMs: 1200, highlightPauseMs: 450 },
        normal: { stepDelayMs: 650, highlightMs: 800, highlightPauseMs: 250 },
        fast: { stepDelayMs: 180, highlightMs: 450, highlightPauseMs: 80 },
        instant: { stepDelayMs: 0, highlightMs: 180, highlightPauseMs: 0 }
    };
    const speed = Object.prototype.hasOwnProperty.call(presets, rawSpeed) ? rawSpeed : "normal";
    const preset = presets[speed] || presets.normal;
    return {
        ...options,
        speed,
        stepDelayMs: Math.max(0, Number(options.stepDelayMs ?? preset.stepDelayMs) || 0),
        highlightMs: Math.max(0, Number(options.highlightMs ?? preset.highlightMs) || 0),
        highlightPauseMs: Math.max(0, Number(options.highlightPauseMs ?? preset.highlightPauseMs) || 0),
        highlight: options.highlight !== false
    };
}

async function replayMacro(id, options = {}) {
    const macro = await getMacro(id);
    return replayMacroSteps(macro, options);
}

async function replayMacroSteps(macro, options = {}) {
    const replayOptions = normalizeReplayOptions(options);
    if (!macro) return { success: false, error: "macro not found" };
    macro = applyMacroInputValues(macro, options.inputValues || {});
    if (!macro.startUrl && !Number.isInteger(Number(options.tabId))) return { success: false, error: "macro has no startUrl" };
    const tab = Number.isInteger(Number(options.tabId))
        ? await chrome.tabs.get(Number(options.tabId))
        : await chrome.tabs.create({ url: macro.startUrl, active: true });
    if (!tab?.id) return { success: false, error: "target tab not found" };
    if (macro.startUrl) {
        await chrome.tabs.update(tab.id, { url: macro.startUrl, active: true });
    } else {
        await chrome.tabs.update(tab.id, { active: true });
    }
    const ready = await waitForTabComplete(tab.id);
    if (!ready) return { success: false, error: "tab failed to load in time" };
    // Small extra grace for SPA hydration.
    await new Promise(r => setTimeout(r, 500));
    const steps = Array.isArray(macro.steps) ? macro.steps : [];
    const startIndex = Math.max(0, Number(replayOptions.startIndex) || 0);
    const endIndex = replayOptions.singleStep ? Math.min(steps.length, startIndex + 1) : steps.length;
    const report = { total: steps.length, startIndex, speed: replayOptions.speed, success: 0, failed: 0, results: [], ok: true };

    for (let i = startIndex; i < endIndex; i++) {
        const step = steps[i];
        if (step.type === "wait_url") {
            const pattern = step.pattern || step.url || "";
            const ok = await waitForTabUrl(tab.id, pattern, Math.max(100, Number(step.timeoutMs) || 10000));
            if (ok) await waitForTabComplete(tab.id, Math.max(1000, Number(step.timeoutMs) || 15000));
            report.results.push({ index: i, type: step.type, ok, error: ok ? undefined : `等待 URL 超时: ${pattern}`, currentUrl: (await chrome.tabs.get(tab.id)).url });
            if (ok) { report.success++; continue; }
            report.failed = 1; report.failedAt = i; report.ok = false; break;
        }
        if (step.type === "navigate") {
            const url = String(step.url || step.pattern || "").trim();
            if (!url) {
                report.results.push({ index: i, type: step.type, ok: false, error: "navigate step 缺少 URL" });
                report.failed = 1; report.failedAt = i; report.ok = false; break;
            }
            await chrome.tabs.update(tab.id, { url });
            const ok = await waitForTabUrl(tab.id, step.pattern || url, Math.max(100, Number(step.timeoutMs) || 10000));
            if (ok) await waitForTabComplete(tab.id, Math.max(1000, Number(step.timeoutMs) || 15000));
            report.results.push({ index: i, type: step.type, ok, error: ok ? undefined : `导航超时: ${url}` });
            if (ok) { report.success++; continue; }
            report.failed = 1; report.failedAt = i; report.ok = false; break;
        }

        const response = await sendMacroPlayToTab(tab.id, [step], { ...replayOptions, singleStep: true });
        const stepReport = response?.report;
        const result = stepReport?.results?.[0];
        if (response?.success && result?.ok) {
            report.results.push({ ...result, index: i, type: step.type });
            report.success++;
            continue;
        }

        const next = steps[i + 1];
        if (!response?.success && next?.type === "wait_url") {
            report.results.push({ index: i, type: step.type, ok: true, warning: response.error || "页面导航导致响应中断" });
            report.success++;
            continue;
        }

        report.results.push({ ...(result || {}), index: i, type: step.type, ok: false, error: result?.error || response?.error || "未知错误" });
        report.failed = 1;
        report.failedAt = i;
        report.ok = false;
        break;
    }

    return { success: true, tabId: tab.id, report };
}

// ========== Message handler (must be registered first for reliable wake-up) ==========

/**
 * Handle messages from the side panel.
 * "tab_extract" sends a message to the target tab's content script
 * to extract page text content. Uses chrome.tabs.sendMessage which
 * communicates with the auto-injected content script (no host_permissions needed).
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "wsbridge") {
    (async () => {
      try {
        switch (msg.action) {
          case "connect":
            await connectWsBridge(msg.url || "");
            sendResponse({ success: true });
            break;
          case "disconnect":
            disconnectWsBridge();
            sendResponse({ success: true });
            break;
          case "status":
            sendResponse({ success: true, ...getWsBridgeStatus() });
            break;
          default:
            sendResponse({ error: `Unknown wsbridge action: ${msg.action}` });
        }
      } catch (error) {
        sendResponse({ error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (msg?.type === "schedule_manager") {
        (async () => {
            try {
                switch (msg.action) {
                    case "schedule":
                        sendResponse(await scheduleJob(msg.payload || {}));
                        break;
                    case "list":
                        sendResponse(await listScheduledJobs());
                        break;
                    case "cancel":
                        sendResponse(await cancelScheduledJob(msg.payload?.scheduleId));
                        break;
                    case "clear_completed":
                        sendResponse(await clearCompletedScheduledJobs());
                        break;
                    default:
                        sendResponse({ error: `Unknown schedule action: ${msg.action}` });
                        break;
                }
            } catch (error) {
                sendResponse({ error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (msg?.type === "macro_manager") {
        (async () => {
            try {
                switch (msg.action) {
                    case "list":
                        sendResponse({ success: true, data: await listMacros() });
                        break;
                    case "list_for_ai": {
                        const macros = await listMacros();
                        const query = String(msg.payload?.query || "").trim().toLowerCase();
                        const filtered = query
                            ? macros.filter(m => m.name.toLowerCase().includes(query))
                            : macros;
                        sendResponse({
                            success: true,
                            data: filtered.map(m => describeMacroForTool(m, { includeSteps: false }))
                        });
                        break;
                    }
                    case "get":
                        sendResponse({ success: true, data: await getMacro(msg.payload?.id) });
                        break;
                    case "describe_for_ai":
                        sendResponse({ success: true, data: describeMacroForTool(await getMacro(msg.payload?.id), { includeSteps: true }) });
                        break;
                    case "save":
                        sendResponse({ success: true, data: await saveMacro(msg.payload) });
                        break;
                    case "delete":
                        sendResponse({ success: true, data: await deleteMacro(msg.payload?.id) });
                        break;
                    case "start":
                        sendResponse(await startMacroRecording(msg.payload || {}));
                        break;
                    case "stop":
                        sendResponse(await stopMacroRecording({
                            commit: msg.payload?.commit !== false,
                            replacePasswords: msg.payload?.replacePasswords === true
                        }));
                        break;
                    case "replay":
                        sendResponse(await replayMacro(msg.payload?.id, {
                            ...(msg.payload?.options || {}),
                            tabId: Number.isInteger(Number(msg.payload?.tabId)) ? Number(msg.payload.tabId) : undefined,
                            inputValues: msg.payload?.inputValues || msg.payload?.options?.inputValues || {}
                        }));
                        break;
                    case "replay_steps":
                        sendResponse(await replayMacroSteps(msg.payload?.macro, {
                            ...(msg.payload?.options || {}),
                            inputValues: msg.payload?.inputValues || msg.payload?.options?.inputValues || {}
                        }));
                        break;
                    case "recording_status":
                        sendResponse({ success: true, data: await getRecording() });
                        break;
                    default:
                        sendResponse({ error: `Unknown macro action: ${msg.action}` });
                }
            } catch (error) {
                sendResponse({ error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (msg?.type === "macro_record_step") {
        (async () => {
            try {
                await appendMacroDraftStep(msg.step);
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({ success: false, error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (msg?.type === "macro_replace_last_step") {
        (async () => {
            try {
                await replaceLastMacroDraftStep(msg.step);
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({ success: false, error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (msg?.type === "macro_get_my_tab_id") {
        const tabId = sender?.tab?.id;
        sendResponse({ tabId: Number.isInteger(tabId) ? tabId : null });
        return false;
    }

    function forwardToTab(tabId, payload) {
        let responded = false;
        const timerId = setTimeout(() => {
            if (responded) return;
            responded = true;
            sendResponse({ success: false, error: "Timed out waiting for content script response" });
        }, 10000);

        chrome.tabs.sendMessage(tabId, payload, (response) => {
            if (responded) return;
            responded = true;
            clearTimeout(timerId);
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else if (response) {
                sendResponse({ success: true, data: response });
            } else {
                sendResponse({ success: false, error: "Content script did not respond" });
            }
        });
    }

    if (msg.type === "tab_extract" && msg.tabId) {
        forwardToTab(msg.tabId, { type: "tab_extract_content" });
        return true;
    }
    if (msg.type === "tab_scroll" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "tab_scroll",
            deltaY: msg.deltaY,
            pageFraction: msg.pageFraction,
            position: msg.position,
            behavior: msg.behavior
        });
        return true;
    }
    if (msg.type === "dom_query" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "dom_query",
            selector: msg.selector,
            text: msg.text,
            matchExact: msg.matchExact,
            maxResults: msg.maxResults
        });
        return true;
    }
    if (msg.type === "dom_click" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "dom_click",
            selector: msg.selector,
            text: msg.text,
            matchExact: msg.matchExact,
            index: msg.index
        });
        return true;
    }
    if (msg.type === "dom_set_value" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "dom_set_value",
            selector: msg.selector,
            text: msg.text,
            matchExact: msg.matchExact,
            index: msg.index,
            value: msg.value
        });
        return true;
    }
    if (msg.type === "dom_style" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "dom_style",
            selector: msg.selector,
            text: msg.text,
            matchExact: msg.matchExact,
            index: msg.index,
            styles: msg.styles,
            durationMs: msg.durationMs
        });
        return true;
    }
    if (msg.type === "dom_get_html" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "dom_get_html",
            selector: msg.selector,
            text: msg.text,
            matchExact: msg.matchExact,
            index: msg.index,
            mode: msg.mode,
            maxLength: msg.maxLength
        });
        return true;
    }
    if (msg.type === "dom_highlight" && msg.tabId) {
        forwardToTab(msg.tabId, {
            type: "dom_highlight",
            selector: msg.selector,
            text: msg.text,
            matchExact: msg.matchExact,
            index: msg.index,
            durationMs: msg.durationMs
        });
        return true;
    }
    if (msg.type === "tab_reuse_prompt_decision") {
        const pending = clearPendingReusePrompt(msg.newTabId);
        if (!pending) {
            sendResponse({ success: false, error: "Reuse prompt is no longer pending" });
            return false;
        }

        applyReuseDecision(pending, msg.decision, !!msg.rememberChoice)
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
        return true;
    }
    return false;
});

// ========== Side panel setup ==========

// Open side panel when extension icon is clicked
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Ignore unsupported/temporary side panel initialization failures.
});

// ========== Tab reuse ==========

// When navigating to a URL already open, switch to that tab instead
chrome.webNavigation.onDOMContentLoaded.addListener(async e => {
    try {
        if (!e?.tabId || e.frameId !== 0) return;
        if (!normalizeReusableUrl(e.url)) return;
        if (pendingReusePrompts.has(e.tabId)) return;

        const reuse = await isTabReuseEnabled();
        if (!reuse) return;

        const reusableTab = await findReusableTab(e.url, { excludeTabId: e.tabId });
        if (!reusableTab) return;

        const domainKey = getReuseDomainKey(e.url);
        const rememberedPolicy = await getReuseDomainPolicy(domainKey);
        if (rememberedPolicy === "keep") return;
        if (rememberedPolicy === "reuse") {
            await focusReusableTab(reusableTab);
            await closeTabIfExists(e.tabId);
            return;
        }

        const newTab = await getTabIfExists(e.tabId);
        const focusedReusableTab = await focusReusableTab(reusableTab);
        const promptResult = await tryShowReusePrompt(focusedReusableTab.id, {
            type: "show_tab_reuse_prompt",
            newTabId: e.tabId,
            existingTabId: focusedReusableTab.id,
            domainKey,
            newUrl: e.url,
            newTitle: newTab?.title || e.url,
            existingUrl: focusedReusableTab.url || e.url,
            existingTitle: focusedReusableTab.title || focusedReusableTab.url || e.url
        });

        if (!promptResult.success) {
            await closeTabIfExists(e.tabId);
            return;
        }

        const timeoutId = setTimeout(() => {
            clearPendingReusePrompt(e.tabId);
        }, REUSE_PROMPT_TIMEOUT_MS);

        pendingReusePrompts.set(e.tabId, {
            newTabId: e.tabId,
            existingTabId: focusedReusableTab.id,
            domainKey,
            timeoutId
        });
    } catch (error) {
        console.warn("Tab reuse failed:", error);
    }
});

// ========== Tab event notifications to side panel ==========

chrome.webNavigation.onCompleted.addListener(async e => {
    if (e.tabId && e.url && e.url.startsWith("http") && e.frameId === 0) {
        try { await chrome.runtime.sendMessage({ type: 'open', tabId: e.tabId }); } catch (e) {/* ignore */}
    }
});

// Fallback: if a JS-triggered navigation happens in the recording tab and our
// content-script hooks didn't intercept it, auto-commit so we don't keep
// recording on the new page.
chrome.webNavigation.onCommitted.addListener(async e => {
    if (e.frameId !== 0) return;
    try {
        const recording = await getRecording();
        if (!recording || recording.tabId !== e.tabId) return;
        if (!e.url) return;
        const currentOrigin = recording.draft?.origin || "";
        const startUrl = recording.draft?.startUrl || "";
        // Allow same-page hash/query updates and reloads of the start URL.
        if (e.url === startUrl) return;
        try {
            const newUrl = new URL(e.url);
            const startUrlParsed = startUrl ? new URL(startUrl) : null;
            if (
                startUrlParsed &&
                newUrl.origin === startUrlParsed.origin &&
                newUrl.pathname === startUrlParsed.pathname
            ) {
                return;
            }
        } catch { /* fall through */ }
        await appendMacroDraftStep({
            type: "wait_url",
            selectors: [],
            url: e.url,
            pattern: e.url,
            timeoutMs: 15000,
            timestamp: Date.now()
        });
        // Keep recording in the same tab after navigation; the new content
        // script will re-activate from chrome.storage.local.macroRecording.
        try {
            chrome.tabs.sendMessage(e.tabId, { type: "macro_activate_check" }, () => void chrome.runtime.lastError);
        } catch { /* ignore */ }
        void currentOrigin; // reserved for future origin-based policy
    } catch (err) {/* ignore */}
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
    clearPendingReusePrompt(tabId);
    for (const [pendingTabId, pending] of pendingReusePrompts.entries()) {
        if (pending.existingTabId === tabId) {
            clearPendingReusePrompt(pendingTabId);
        }
    }
    try { await chrome.runtime.sendMessage({ type: 'close', tabId }); } catch (e) {/* ignore */}

    // If the closed tab was the recording tab, auto-commit whatever is buffered.
    try {
        const recording = await getRecording();
        if (recording && recording.tabId === tabId) {
            // The page is gone, so we cannot ask the user whether to keep
            // password values. Prefer the safer placeholder path for this
            // exceptional auto-commit.
            await stopMacroRecording({ commit: true, replacePasswords: true });
        }
    } catch (e) {/* ignore */}
});

chrome.tabs.onActivated.addListener(async function (activeInfo) {
    try { await chrome.runtime.sendMessage({ type: 'active', tabId: activeInfo.tabId }); } catch (e) {/* ignore */}
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms?.create("ws-bridge-health", { periodInMinutes: 1 });
    void restoreScheduledJobs();
    void startWsBridge();
});

chrome.runtime.onStartup.addListener(() => {
    void restoreScheduledJobs();
    void startWsBridge();
});

void restoreScheduledJobs();
void startWsBridge();

if (chrome.alarms) {
    chrome.alarms.get("ws-bridge-health", (alarm) => {
        if (!alarm) chrome.alarms.create("ws-bridge-health", { periodInMinutes: 1 });
    });

    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name.startsWith(SCHEDULE_FIRE_ALARM_PREFIX)) {
            await runScheduledJob(alarm.name.slice(SCHEDULE_FIRE_ALARM_PREFIX.length));
            return;
        }

        if (alarm.name.startsWith(SCHEDULE_CLEANUP_ALARM_PREFIX)) {
            await cleanupScheduledJob(alarm.name.slice(SCHEDULE_CLEANUP_ALARM_PREFIX.length));
            return;
        }

        if (alarm.name !== "ws-bridge-health") return;

        await ensureWsBridgeHealthy();
    });
}
