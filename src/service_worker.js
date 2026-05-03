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

const REUSE_PROMPT_TIMEOUT_MS = 30000;
const pendingReusePrompts = new Map();
const SCHEDULE_STORAGE_KEY = "scheduledJobs";
const SCHEDULE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
const SCHEDULE_FIRE_ALARM_PREFIX = "schedule-fire:";
const SCHEDULE_CLEANUP_ALARM_PREFIX = "schedule-cleanup:";
const TERMINAL_SCHEDULE_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

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

chrome.tabs.onRemoved.addListener(async function (tabId) {
    clearPendingReusePrompt(tabId);
    for (const [pendingTabId, pending] of pendingReusePrompts.entries()) {
        if (pending.existingTabId === tabId) {
            clearPendingReusePrompt(pendingTabId);
        }
    }
    try { await chrome.runtime.sendMessage({ type: 'close', tabId }); } catch (e) {/* ignore */}
});

chrome.tabs.onActivated.addListener(async function (activeInfo) {
    try { await chrome.runtime.sendMessage({ type: 'active', tabId: activeInfo.tabId }); } catch (e) {/* ignore */}
    let { tabActivity } = await chrome.storage.local.get({ tabActivity: {} });
    tabActivity[activeInfo.tabId] = Date.now();
    await chrome.storage.local.set({ tabActivity });
});

// ========== Auto memory release ==========

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms?.create("check-idle-tabs", { periodInMinutes: 1 });
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
    chrome.alarms.get("check-idle-tabs", (alarm) => {
        if (!alarm) chrome.alarms.create("check-idle-tabs", { periodInMinutes: 1 });
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

        if (alarm.name !== "check-idle-tabs") return;

        await ensureWsBridgeHealthy();

        let { suspendTimeout, tabActivity } = await chrome.storage.local.get({
            suspendTimeout: 0,
            tabActivity: {}
        });
        if (!suspendTimeout || suspendTimeout <= 0) return;

        const now = Date.now();
        const timeoutMs = suspendTimeout * 60 * 1000;
        const tabs = await chrome.tabs.query({});

        for (const tab of tabs) {
            if (tab.active || tab.pinned || tab.discarded || !tab.url || !tab.url.startsWith("http")) continue;
            const lastActive = tabActivity[tab.id] || 0;
            if (lastActive > 0 && (now - lastActive) > timeoutMs) {
                try { await chrome.tabs.discard(tab.id); } catch (e) {/* ignore */}
            }
        }
    });
}
