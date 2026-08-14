import { streamChat } from "../../../../api/llm";
import { buildApiMessages } from "./buildApiMessages";
import { buildAssistantToolCallMessage } from "../messages/assistantMessages";
import { serializeToolResult, summarizeToolResult } from "../messages/toolResults";
import { buildWebSearchActionLabels } from "../../webSearchActions";
import {
  SUBAGENT_DEFAULT_MAX_ITERATIONS,
  SUBAGENT_MAX_ITERATIONS,
  SUBAGENT_TOOL_TIMEOUT_SECONDS
} from "../../../../api/llm/core/constants";

export const SUBAGENT_TOOL_NAME = "create_subagent";

// Host-context tools that are handled by the parent agent loop rather than the
// generic executor. The sub-agent must never see (or be able to invoke) them:
// it has the same underlying tool set as the parent minus these + recursion.
const SUBAGENT_EXCLUDED_TOOL_NAMES = [
  SUBAGENT_TOOL_NAME,
  "tool_list_group",
  "tool_enable",
  "plan_create_for_session",
  "plan_update_for_session",
  "request_user_input"
];

const MAX_STEP_SUMMARY_CHARS = 200;
const MAX_STEP_TITLE_DETAIL_CHARS = 160;
const MAX_STEPS = SUBAGENT_MAX_ITERATIONS;

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a sub-agent of a larger assistant.",
  "Complete the task autonomously using the available tools, then reply with a concise, self-contained final answer.",
  "Do not ask the user for clarification; make reasonable assumptions and state them briefly in your answer.",
  "You cannot create further sub-agents.",
  "Respond in the same language as the task."
].join("\n");

export function truncateSubagentText(text, max = MAX_STEP_SUMMARY_CHARS) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const suffix = "…";
  return normalized.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

export function buildSubagentStepTitle(toolCall) {
  const name = String(toolCall?.name || "tool");
  const args = toolCall?.args;
  let detail = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args).slice(0, 2);
    if (entries.length > 0) {
      detail = entries
        .map(([key, value]) => `${key}=${truncateSubagentText(typeof value === "string" ? value : JSON.stringify(value), MAX_STEP_TITLE_DETAIL_CHARS)}`)
        .join(", ");
    }
  }
  return detail ? `${name}(${detail})` : name;
}

export function summarizeSubagentStep(result) {
  if (!result || typeof result !== "object") return truncateSubagentText(result);
  if (typeof result.error === "string" && result.error) {
    return `error: ${truncateSubagentText(result.error)}`;
  }
  const summary = result.summary ?? result.message ?? result.content ?? result;
  try {
    return truncateSubagentText(JSON.stringify(summary));
  } catch (_e) {
    return truncateSubagentText(String(summary));
  }
}

function extractAnswerText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(block => block?.type === "text")
      .map(block => String(block.text || ""))
      .join("\n");
    if (text) return text;
  }
  return content || "";
}

function normalizeIterationLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return SUBAGENT_DEFAULT_MAX_ITERATIONS;
  return Math.min(Math.floor(n), SUBAGENT_MAX_ITERATIONS);
}

function withDeadline(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

function streamSubagentTurn(config, fullMessages, mcpTools, options = {}, onNativeWebSearch) {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const abort = streamChat(config, fullMessages, {
    onDone: (msg) => {
      if (settled) return;
      settled = true;
      resolvePromise(msg);
    },
    onError: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    onText: options.onText,
    onToolArgsDelta: options.onToolArgsDelta,
    onToolArgsDone: options.onToolArgsDone,
    onNativeWebSearch
  }, mcpTools, options);
  return {
    promise,
    abort: () => {
      if (settled) return;
      settled = true;
      abort();
      const error = new Error("Sub-agent aborted");
      error.name = "AbortError";
      rejectPromise(error);
    }
  };
}

/**
 * Run a single-layer sub-agent loop entirely in memory. The full request
 * history is never persisted; only a compact per-step summary is returned
 * (and the host may persist those summaries as tool-call metadata).
 *
 * @param {{task?: string, maxIterations?: number}} [input]
 * @param {Object} options
 * @returns {Promise<{success: boolean, answer?: string, error?: string, code?: string, toolCallCount?: number, durationMs?: number, steps: Array}>}
 */
export async function runSubagent(
  { task, maxIterations } = {},
  {
    config,
    sessionId = "",
    subagentId = "",
    templatePrompt = "",
    allowedBuiltinDomains = [],
    restrictBuiltinDomains = false,
    mcpTools = [],
    invokeTool,
    transformToolResult,
    onStep,
    onMessage,
    onToolArgsDelta,
    onToolArgsDone,
    isCancelled = () => false,
    timeoutMs = SUBAGENT_TOOL_TIMEOUT_SECONDS * 1000,
    excludeToolNames = SUBAGENT_EXCLUDED_TOOL_NAMES,
    supportsImageInput = false,
    supportsToolImageInput = false,
    imageToolsEnabled = false,
    postdogToolsEnabled = false,
    useCodeMode = true,
    omitThinkingFromRequests = false,
    nativeWebSearch = false
  } = {}
) {
  const startedAt = Date.now();
  const normalizedTask = String(task || "").trim();
  if (!normalizedTask) {
    return { success: false, error: "task is required", code: "SUBAGENT_INVALID_TASK", steps: [] };
  }
  if (typeof invokeTool !== "function") {
    return { success: false, error: "Sub-agent tool runtime is unavailable", code: "SUBAGENT_RUNTIME_UNAVAILABLE", steps: [] };
  }

  const iterationLimit = normalizeIterationLimit(maxIterations);
  const cacheSessionId = [String(sessionId || "").trim(), String(subagentId || "").trim()]
    .filter(Boolean)
    .join(":");
  const deadline = startedAt + Math.max(1, Number(timeoutMs) || SUBAGENT_TOOL_TIMEOUT_SECONDS * 1000);
  const steps = [];
  const history = [{ role: "user", content: normalizedTask }];
  const buildOptions = () => ({
    supportsImageInput,
    supportsToolImageInput,
    omitThinkingFromRequests,
    nativeWebSearch
  });

  let activeAbort = null;
  const isCancelledSafe = () => {
    try {
      return isCancelled() === true;
    } catch (_e) {
      return false;
    }
  };
  const isExpired = () => Date.now() >= deadline;
  const shouldStop = () => isCancelledSafe() || isExpired();
  const emitSteps = () => {
    onStep?.(null, steps.slice(0, MAX_STEPS).map(s => ({ ...s })));
  };

  const webSearchStepById = new Map();
  const upsertWebSearchStep = (id, action, status) => {
    if (!id) return;
    const labels = buildWebSearchActionLabels(action || {});
    const title = labels[0] || "web_search";
    const normalizedStatus = status === "in_progress" ? "running" : "completed";
    const existingIndex = webSearchStepById.get(id);
    if (existingIndex != null) {
      const existingStep = steps[existingIndex];
      if (existingStep) {
        if (title !== "web_search") existingStep.title = title;
        existingStep.status = normalizedStatus;
        emitSteps();
      }
      return;
    }
    webSearchStepById.set(id, steps.length);
    steps.push({ name: "web_search", title, summary: "", status: normalizedStatus, durationMs: 0 });
    emitSteps();
  };
  const handleNativeWebSearch = (event) => {
    if (!event || !event.id) return;
    upsertWebSearchStep(event.id, event.action, event.status);
  };

  try {
    for (let round = 0; round < iterationLimit; round++) {
      if (shouldStop()) {
        return {
          success: false,
          error: isCancelledSafe() ? "Sub-agent was cancelled" : "Sub-agent timed out",
          code: isCancelledSafe() ? "SUBAGENT_CANCELLED" : "SUBAGENT_TIMEOUT",
          steps,
          durationMs: Date.now() - startedAt
        };
      }

      const apiMessages = buildApiMessages(config.apiType, history, buildOptions());
      const systemPrompt = templatePrompt.trim()
        ? `${SUBAGENT_SYSTEM_PROMPT}\n\nTemplate instructions:\n${templatePrompt.trim()}`
        : SUBAGENT_SYSTEM_PROMPT;
      const fullMessages = [{ role: "system", content: systemPrompt }, ...apiMessages];

      let streamedText = "";
      // Text can arrive on any turn; the latest turn is the useful progress
      // signal while tools are running, and the final turn becomes the answer.
      const turn = streamSubagentTurn(config, fullMessages, mcpTools, {
        excludeToolNames,
        supportsImageInput,
        imageToolsEnabled,
        postdogToolsEnabled,
        useCodeMode,
        allowedBuiltinDomains,
        restrictBuiltinDomains,
        ...(cacheSessionId ? { sessionId: cacheSessionId } : {}),
        onText: chunk => {
          streamedText += String(chunk || "");
          onMessage?.(streamedText);
        },
        onToolArgsDelta,
        onToolArgsDone
      }, handleNativeWebSearch);
      activeAbort = turn.abort;
      let msg;
      try {
        msg = await withDeadline(turn.promise, Math.max(1, deadline - Date.now()), "Sub-agent timed out");
      } catch (error) {
        activeAbort?.();
        if (isCancelledSafe()) {
          return { success: false, error: "Sub-agent was cancelled", code: "SUBAGENT_CANCELLED", steps, durationMs: Date.now() - startedAt };
        }
        if (isExpired()) {
          return { success: false, error: "Sub-agent timed out", code: "SUBAGENT_TIMEOUT", steps, durationMs: Date.now() - startedAt };
        }
        return { success: false, error: error?.message || String(error), code: "SUBAGENT_LLM_ERROR", steps, durationMs: Date.now() - startedAt };
      } finally {
        activeAbort = null;
      }

      // Reconcile web search step titles from the final message, whose action
      // is authoritative (the per-event action may arrive empty).
      if (Array.isArray(msg?.web_searches)) {
        for (const search of msg.web_searches) {
          if (search?.id) upsertWebSearchStep(search.id, search.action, "completed");
        }
      }

      if (!Array.isArray(msg?.toolCalls) || msg.toolCalls.length === 0) {
        onMessage?.(extractAnswerText(msg));
        return {
          success: true,
          answer: extractAnswerText(msg),
          toolCallCount: steps.length,
          steps,
          durationMs: Date.now() - startedAt
        };
      }

      history.push(buildAssistantToolCallMessage(config.apiType, config.model, "", msg));

      for (const tc of msg.toolCalls) {
        if (shouldStop()) {
          activeAbort?.();
          return {
            success: false,
            error: isCancelledSafe() ? "Sub-agent was cancelled" : "Sub-agent timed out",
            code: isCancelledSafe() ? "SUBAGENT_CANCELLED" : "SUBAGENT_TIMEOUT",
            steps,
            durationMs: Date.now() - startedAt
          };
        }

        const placeholderStep = {
          name: String(tc.name || "tool"),
          title: buildSubagentStepTitle(tc),
          summary: "",
          status: "running",
          durationMs: 0
        };
        const placeholderIndex = steps.length;
        steps.push(placeholderStep);
        emitSteps();

        const t0 = Date.now();
        let result;
        if (tc.name === SUBAGENT_TOOL_NAME) {
          result = { error: "Sub-agents cannot create further sub-agents", code: "SUBAGENT_DEPTH_EXCEEDED" };
        } else {
          try {
            result = await invokeTool(tc.name, tc.args);
          } catch (error) {
            result = { error: error?.message || String(error) };
          }
        }

        const nestedCalls = Array.isArray(result?._subagentNestedCalls) ? result._subagentNestedCalls : [];
        let serializableResult = result;
        if (result && typeof result === "object" && Array.isArray(result._subagentNestedCalls)) {
          const { _subagentNestedCalls, ...rest } = result;
          serializableResult = rest;
        }
        if (transformToolResult) {
          try {
            const transformed = await transformToolResult({ name: tc.name, args: tc.args, result: serializableResult });
            serializableResult = transformed && Object.prototype.hasOwnProperty.call(transformed, "value")
              ? transformed.value
              : serializableResult;
          } catch (_e) {
            // keep the untransformed result
          }
        }

        const durationMs = Date.now() - t0;
        if (nestedCalls.length > 0) {
          // Replace the exec placeholder with one step per nested tool call.
          steps.splice(placeholderIndex, 1);
          for (const nested of nestedCalls) {
            steps.push({
              name: String(nested.name || "tool"),
              title: String(nested.title || nested.name || "tool"),
              summary: String(nested.summary || ""),
              status: nested.status === "failed" ? "error" : (nested.status || "completed"),
              durationMs: Number(nested.durationMs) || 0,
              ...(nested.error != null ? { error: nested.error } : {})
            });
          }
          emitSteps();
        } else {
          placeholderStep.status = serializableResult?.error ? "error" : "completed";
          placeholderStep.summary = summarizeSubagentStep(serializableResult);
          placeholderStep.durationMs = durationMs;
          if (serializableResult?.error != null) placeholderStep.error = serializableResult.error;
          emitSteps();
        }

        history.push({
          role: "tool",
          tool_call_id: tc.id,
          response_call_id: tc.responseCallId || undefined,
          tool_name: tc.name,
          content: serializeToolResult(summarizeToolResult(serializableResult))
        });
      }
    }

    return {
      success: false,
      error: "Sub-agent exceeded the maximum number of iterations",
      code: "SUBAGENT_MAX_ITERATIONS",
      steps,
      durationMs: Date.now() - startedAt
    };
  } finally {
    activeAbort?.();
  }
}
