import { resolveLlmRequestUrl } from "../core/endpoint";
import { API_TYPES } from "../core/config";
import { buildFirstPacketTimeoutError, createFirstPacketTimeoutState, createLlmStreamError, getFirstPacketTimeoutMs, isAbortError, mergeUsage } from "../core/shared";
import { getTools } from "../tools/definitions";
import { isLongToolArgumentName } from "../core/longToolArgs";
import { buildOpenAIChatReasoningFields } from "../core/reasoning";

export function buildOpenAICacheFields(options = {}) {
  const cacheKey = String(options?.sessionId || "").trim();
  return cacheKey ? { prompt_cache_key: cacheKey } : {};
}

// ==================== OpenAI Compatible ====================

export async function streamOpenAIAttempt(config, messages, signal, { onText, onThinking, onDone, onToolArgsDelta, onToolArgsDone }, mcpTools = [], options = {}) {
  const tools = getTools(API_TYPES.OPENAI_CHAT_COMPLETIONS, mcpTools, options);
  const url = resolveLlmRequestUrl(API_TYPES.OPENAI_CHAT_COMPLETIONS, config.baseUrl);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...buildOpenAIChatMaxTokens(options),
        ...buildOpenAIChatReasoningFields(config),
        ...buildOpenAICacheFields(options)
      }),
      signal: timeoutState.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw createLlmStreamError({
        code: `HTTP_${res.status}`,
        message: `LLM 接口返回 HTTP ${res.status}`,
        status: res.status,
        detail: errText || `HTTP ${res.status}`
      });
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw createLlmStreamError({
        code: "EMPTY_RESPONSE_BODY",
        message: "LLM 未返回响应流"
      });
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    const reasoningFields = {};
    const reasoningDetails = [];
    let toolCallsMap = {};
    let buffer = "";
    let sawToolCallDelta = false;
    let usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        timeoutState.markFirstPacketReceived();
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          usage = mergeUsage(usage, extractOpenAIStreamUsage(json));
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            onText?.(delta.content);
          }

          const reasoningDeltas = extractOpenAIReasoningDeltas(delta);
          for (const [field, chunk] of Object.entries(reasoningDeltas)) {
            reasoningFields[field] = (reasoningFields[field] || "") + chunk;
            onThinking?.(chunk, { field, provider: API_TYPES.OPENAI_CHAT_COMPLETIONS });
          }
          if (Array.isArray(delta.reasoning_details)) {
            reasoningDetails.push(...delta.reasoning_details);
            if (Object.keys(reasoningDeltas).length === 0) {
              const reasoningDetailsText = extractReasoningText(delta.reasoning_details);
              if (reasoningDetailsText) {
                onThinking?.(reasoningDetailsText, { field: "reasoning_details", provider: API_TYPES.OPENAI_CHAT_COMPLETIONS });
              }
            }
          }

          if (delta.tool_calls) {
            sawToolCallDelta = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: "", name: "", arguments: "" };
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name = tc.function.name;
              if (tc.function?.name && isLongToolArgumentName(toolCallsMap[idx].name)) {
                onToolArgsDelta?.({
                  id: toolCallsMap[idx].id || `toolcall_index_${idx}`,
                  index: idx,
                  name: toolCallsMap[idx].name,
                  delta: "",
                  arguments: toolCallsMap[idx].arguments
                });
              }
              if (typeof tc.function?.arguments === "string") {
                toolCallsMap[idx].arguments += tc.function.arguments;
                if (isLongToolArgumentName(toolCallsMap[idx].name)) {
                  onToolArgsDelta?.({
                    id: toolCallsMap[idx].id || `toolcall_index_${idx}`,
                    index: idx,
                    name: toolCallsMap[idx].name,
                    delta: tc.function.arguments,
                    arguments: toolCallsMap[idx].arguments
                  });
                }
              }
            }
          }
        } catch (error) {
          throw createLlmStreamError({
            code: "STREAM_PARSE_ERROR",
            message: "解析 OpenAI 流式响应失败",
            detail: error?.message || String(error)
          });
        }
      }
    }


    const rawToolCalls = Object.entries(toolCallsMap)
      .filter(([, tc]) => tc.name)
      .map(([idx, tc]) => ({
        index: Number(idx),
        id: tc.id || `toolcall_${idx}_${Date.now()}`,
        name: tc.name,
        arguments: tc.arguments
      }));

    for (const tc of rawToolCalls) {
      if (isLongToolArgumentName(tc.name)) {
        onToolArgsDone?.({
          id: tc.id,
          index: tc.index,
          name: tc.name,
          arguments: tc.arguments
        });
      }
    }

    const parseFailures = [];
    const toolCalls = rawToolCalls
      .map(tc => {
        try {
          return {
            id: tc.id,
            responseItemId: tc.responseItemId || "",
            name: tc.name,
            args: JSON.parse(tc.arguments || "{}"),
            _raw: tc.arguments || "{}"
          };
        } catch (error) {
          parseFailures.push({ name: tc.name, arguments: tc.arguments, error: error.message });
          return null;
        }
      })
      .filter(Boolean);

    if (parseFailures.length > 0) {
      throw createLlmStreamError({
        code: "TOOL_CALL_PARSE_ERROR",
        message: "工具调用参数解析失败",
        detail: parseFailures
      });
    }

    if (sawToolCallDelta && toolCalls.length === 0 && !fullContent) {
      throw createLlmStreamError({
        code: "EMPTY_TOOL_CALL_STREAM",
        message: "模型返回了工具调用片段，但未能重建有效工具调用"
      });
    }

    onDone?.({
      role: "assistant",
      content: fullContent || null,
      ...reasoningFields,
      ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
      ...(usage ? { usage } : {}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      _openaiToolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc._raw }
      })) : undefined
    });
  } catch (error) {
    if (timeoutState.didTimeout && !signal.aborted) {
      throw buildFirstPacketTimeoutError(config);
    }
    if (isAbortError(error) && signal.aborted) {
      throw error;
    }
    throw error;
  } finally {
    timeoutState.cleanup();
  }
}

function buildOpenAIChatMaxTokens(options = {}) {
  const maxTokens = normalizeStreamMaxTokens(options.maxTokens);
  return maxTokens ? { max_tokens: maxTokens } : {};
}

function normalizeStreamMaxTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(8192, Math.floor(number));
}



export function extractOpenAIReasoningDeltas(delta) {
  if (!delta || typeof delta !== "object") return {};

  const result = {};
  for (const field of ["reasoning_content", "reasoning", "thinking"]) {
    const value = extractReasoningText(delta[field]);
    if (value) result[field] = value;
  }
  return result;
}

function extractReasoningText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractReasoningText).join("");
  if (value && typeof value === "object") {
    return [
      value.reasoning_content,
      value.thinking,
      value.text,
      value.summary,
      value.summary_text,
      value.content,
      value.output_text
    ].map(extractReasoningText).join("");
  }
  return "";
}

export function extractOpenAIStreamUsage(event) {
  if (!event || typeof event !== "object") return null;
  return firstUsageObject(
    event.usage,
    event.response?.usage,
    event.message?.usage,
    event.choices?.[0]?.usage,
    event.choices?.[0]?.delta?.usage
  );
}

export function firstUsageObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}
