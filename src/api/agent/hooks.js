import Sval from "sval";
import { normalizeLlmModelProfiles, resolveActiveLlmConfig } from "../llm/core/modelProfiles";
import { textComplete } from "../llm/providers/textComplete";

export const AGENT_HOOKS_STORAGE_KEY = "agentHooks";
export const AGENT_HOOK_EVENTS = ["agent.run", "llm.request", "tool.call", "context.compact", "subagent.run"];
export const DEFAULT_HOOK_TIMEOUT_MS = 1500;

export function createHookLlmRuntime(llmConfig = {}) {
  const { profiles, activeId } = normalizeLlmModelProfiles(llmConfig);
  const publicProfiles = profiles.map(profile => ({
    id: profile.id,
    name: profile.name,
    model: profile.model,
    apiType: profile.apiType,
    requiresApiKey: profile.requiresApiKey !== false
  }));
  const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
  return {
    profiles: () => publicProfiles.map(profile => ({ ...profile })),
    activeProfileId: () => activeId,
    complete: async ({ profileId = activeId, messages = [], maxTokens, sessionId, allowEmptyResponse = false } = {}) => {
      const profile = profilesById.get(String(profileId || "").trim());
      if (!profile) throw new Error(`LLM profile not found: ${String(profileId || "")}`);
      const config = resolveActiveLlmConfig({ ...llmConfig, llmModels: [profile], activeLlmModelId: profile.id });
      return await textComplete(config, messages, { maxTokens, sessionId, allowEmptyResponse });
    }
  };
}

export function createEmptyAgentHook() {
  return {
    id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: "New hook",
    event: "tool.call",
    enabled: true,
    priority: 0,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    code: `async ({ phase, context, state }) => {
  if (phase === "before") {
    console.log("[hook before]", {
      event: context.event,
      tool: context.data?.tool,
      args: context.data?.args,
      input: context.data?.input
    });

    return {
      state: {
        startedAt: Date.now(),
        toolName: context.data?.tool?.name || ""
      }
      // 如需修改默认流程，可额外返回：
      // changes: { args: { ...context.data.args } }
    };
  }

  if (phase === "after") {
    console.log("[hook after]", {
      event: context.event,
      tool: context.data?.tool,
      args: context.data?.args,
      result: context.data?.result,
      durationMs: state?.startedAt ? Date.now() - state.startedAt : null
    });
    return;
  }

  if (phase === "error") {
    console.error("[hook error]", {
      event: context.event,
      tool: context.data?.tool,
      args: context.data?.args,
      error: context.data?.error,
      durationMs: state?.startedAt ? Date.now() - state.startedAt : null
    });
    return;
  }

  if (phase === "cancel") {
    console.warn("[hook cancel]", {
      event: context.event,
      tool: context.data?.tool,
      reason: context.data?.reason,
      state
    });
  }
}`
  };
}

export function normalizeAgentHooks(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map(item => {
      const id = String(item?.id || "").trim();
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const event = AGENT_HOOK_EVENTS.includes(item?.event) ? item.event : "tool.call";
      return {
        id,
        name: String(item?.name ?? "").trim(),
        event,
        enabled: item?.enabled !== false,
        priority: Number.isFinite(Number(item?.priority)) ? Math.trunc(Number(item.priority)) : 0,
        timeoutMs: Math.max(100, Math.min(10000, Number(item?.timeoutMs) || DEFAULT_HOOK_TIMEOUT_MS)),
        code: String(item?.code || "")
      };
    })
    .filter(Boolean)
    .sort(compareHooks);
}

export async function loadAgentHooks() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) return [];
  const result = await chrome.storage.local.get({ [AGENT_HOOKS_STORAGE_KEY]: [] });
  return normalizeAgentHooks(result[AGENT_HOOKS_STORAGE_KEY]);
}

export async function saveAgentHooks(hooks) {
  const normalized = normalizeAgentHooks(hooks);
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    await chrome.storage.local.set({ [AGENT_HOOKS_STORAGE_KEY]: normalized });
  }
  return normalized;
}

export async function runAroundHooks({ event, context, hooks = [], builtins = [], operation, runtime = {}, onDiagnostic = console.warn }) {
  const chain = [
    ...builtins.map((hook, index) => ({ ...hook, id: hook.id || `builtin_${index}`, priority: Number(hook.priority) || 0, builtin: true })),
    ...normalizeAgentHooks(hooks).filter(hook => hook.enabled && hook.event === event)
  ].sort(compareHooks);
  let data = cloneJson(context?.data || {});
  const frames = [];

  for (const hook of chain) {
    const hookContext = { ...context, event: `${event}.before`, data: cloneJson(data) };
    try {
      const output = await invokeHook(hook, "before", hookContext, null, runtime);
      if (output?.changes && isPlainObject(output.changes)) {
        data = mergeChanges(data, output.changes);
      }
      frames.push({ hook, state: output?.state ?? null });
      if (output?.action === "cancel") {
        await finishHooks(frames, "cancel", context, data, { reason: String(output.reason || "Hook cancelled operation") }, runtime, onDiagnostic);
        return { cancelled: true, reason: String(output.reason || "Hook cancelled operation"), data };
      }
    } catch (error) {
      reportDiagnostic(onDiagnostic, hook, "before", error);
    }
  }

  try {
    const result = await operation(data);
    await finishHooks(frames, "after", context, data, { result }, runtime, onDiagnostic);
    return { result, data, cancelled: false };
  } catch (error) {
    await finishHooks(frames, "error", context, data, { error: serializeError(error) }, runtime, onDiagnostic);
    throw error;
  }
}

async function finishHooks(frames, phase, context, data, completion, runtime, onDiagnostic) {
  for (const frame of [...frames].reverse()) {
    try {
      await invokeHook(frame.hook, phase, { ...context, event: `${context.eventBase || context.event || "hook"}.${phase}`, data: cloneJson({ ...data, ...completion }) }, frame.state, runtime);
    } catch (error) {
      reportDiagnostic(onDiagnostic, frame.hook, phase, error);
    }
  }
}

async function invokeHook(hook, phase, context, state, runtime) {
  if (hook.builtin) return await withTimeout(hook.run({ phase, context, state }), hook.timeoutMs || DEFAULT_HOOK_TIMEOUT_MS);
  const handler = compileHook(hook.code, runtime);
  return await withTimeout(handler({ phase, context, state }), hook.timeoutMs);
}

function compileHook(code, runtime = {}) {
  const source = String(code || "").trim();
  if (!source) throw new Error("Hook code is empty");
  const interpreter = new Sval({ ecmaVer: "latest", sourceType: "script", sandBox: true });
  interpreter.import({
    console,
    fetch: typeof runtime.fetch === "function" ? runtime.fetch : undefined,
    chrome: runtime.chrome || undefined,
    llm: runtime.llm || undefined
  });
  const expression = /^(async\s+)?(?:function\s*)?\(?\s*(?:\{|[A-Za-z_$])/u.test(source) && source.includes("=>")
    ? source
    : `async ({ phase, context, state }) => {\n${source}\n}`;
  interpreter.run(`exports.hook = (${expression});`);
  if (typeof interpreter.exports.hook !== "function") throw new Error("Hook code must evaluate to a function");
  return interpreter.exports.hook;
}

function withTimeout(promise, timeoutMs) {
  const ms = Math.max(100, Number(timeoutMs) || DEFAULT_HOOK_TIMEOUT_MS);
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Hook timed out after ${ms}ms`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function mergeChanges(data, changes) {
  const target = cloneJson(data);
  for (const [key, value] of Object.entries(changes)) {
    if (isUnsafeKey(key)) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) target[key] = mergeChanges(target[key], value);
    else target[key] = cloneJson(value);
  }
  return target;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isUnsafeKey(key) {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function compareHooks(a, b) {
  return (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.id).localeCompare(String(b.id));
}

function serializeError(error) {
  return { name: error?.name || "Error", message: error?.message || String(error) };
}

function reportDiagnostic(onDiagnostic, hook, phase, error) {
  try {
    const message = `[agent hook] ${hook.name || hook.id} ${phase} skipped: ${error?.message || String(error)}`;
    console.warn(message);
    onDiagnostic?.(message);
  } catch (_error) {}
}
