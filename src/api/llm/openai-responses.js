import { resolveLlmRequestUrl } from "../llmEndpoint";
import { API_TYPES } from "./config";
import { buildFirstPacketTimeoutError, createFirstPacketTimeoutState, createLlmStreamError, getFirstPacketTimeoutMs, isAbortError, mergeUsage } from "./shared";
import { getTools } from "./tools";
import { buildOpenAICacheFields, firstUsageObject } from "./openai-chat-completions";
import { isLongToolArgumentName } from "./longToolArgs";
import { buildOpenAIResponsesReasoningFields } from "./reasoning";

export async function streamOpenAIResponsesAttempt(config, messages, signal, { onText, onDone, onToolArgsDelta, onToolArgsDone }, mcpTools = [], options = {}) {
  const tools = getTools(API_TYPES.OPENAI_RESPONSES, mcpTools, options);
  const url = resolveLlmRequestUrl(API_TYPES.OPENAI_RESPONSES, config.baseUrl);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    const { instructions, input } = buildResponsesRequestInput(messages);
    const requestBody = {
      model: config.model,
      input,
      tools,
      stream: true,
      ...(instructions ? { instructions } : {}),
      ...buildOpenAIResponsesReasoningFields(config),
      ...buildOpenAICacheFields(options)
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(requestBody),
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
    let buffer = "";
    let usage = null;
    let responseId = "";
    const outputItems = new Map();
    const toolCallsById = new Map();

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
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          if (event?.response?.id) {
            responseId = event.response.id;
          }
          usage = mergeUsage(usage, extractOpenAIResponsesUsage(event));
          applyResponsesStreamEvent(event, outputItems, toolCallsById, { onText, onToolArgsDelta, onToolArgsDone });
        } catch (error) {
          throw createLlmStreamError({
            code: "STREAM_PARSE_ERROR",
            message: "解析 OpenAI Responses 流式响应失败",
            detail: error?.message || String(error)
          });
        }
      }
    }


    const orderedItems = [...outputItems.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const textParts = [];
    for (const item of orderedItems) {
      if (item.type === "message") {
        for (const part of item.content || []) {
          if ((part?.type === "output_text" || part?.type === "text") && typeof part?.text === "string") {
            textParts.push(part.text);
          }
        }
      }
    }

    const toolCalls = dedupeResponsesFunctionCalls([...toolCallsById.values()])
      .filter(tc => tc.name)
      .map(tc => {
        const raw = tc.arguments || "{}";
        try {
          return {
            id: tc.call_id || tc.id || `toolcall_${Date.now()}`,
            responseItemId: tc.id || "",
            name: tc.name,
            args: JSON.parse(raw),
            _raw: raw
          };
        } catch (error) {
          throw createLlmStreamError({
            code: "TOOL_CALL_PARSE_ERROR",
            message: "工具调用参数解析失败",
            detail: { name: tc.name, arguments: raw, error: error?.message || String(error) }
          });
        }
      });

    const messageContent = orderedItems
      .filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(Boolean);

    onDone?.({
      role: "assistant",
      content: textParts.join("") || null,
      ...(messageContent.length > 0 ? { response_content: messageContent } : {}),
      ...(usage ? { usage } : {}),
      ...(responseId ? { response_id: responseId } : {}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      _openaiToolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        response_item_id: tc.responseItemId || undefined,
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

function buildResponsesRequestInput(messages) {
  const instructionsParts = [];
  const input = [];

  for (const msg of messages || []) {
    if (!msg) continue;

    if (msg.role === "system" || msg.role === "developer") {
      const text = extractPlainMessageText(msg.content);
      if (text) instructionsParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "")
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const text = extractPlainMessageText(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }]
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          id: tc.response_item_id || tc.id,
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}"
        });
      }
      continue;
    }

    input.push({
      type: "message",
      role: msg.role || "user",
      content: normalizeResponsesMessageContent(msg.content, msg.role || "user")
    });
  }

  return {
    instructions: instructionsParts.join("\n\n").trim() || undefined,
    input
  };
}

function extractPlainMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (!block || typeof block !== "object") return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .join("")
      .trim();
  }
  if (content == null) return "";
  return String(content).trim();
}

function applyResponsesStreamEvent(event, outputItems, toolCallsById, { onText, onToolArgsDelta, onToolArgsDone } = {}) {
  const eventType = String(event?.type || "");

  if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
    const item = normalizeResponsesOutputItem(event?.item, event?.output_index);
    if (item) {
      outputItems.set(item.id || `${item.type}:${item.order}`, item);
      if (item.type === "function_call") {
        const call = mergeResponsesFunctionCall(toolCallsById, item.call_id || item.id, {
          id: item.id || "",
          call_id: item.call_id || item.id || "",
          name: item.name || "",
          arguments: item.arguments || ""
        });
        if (item.id) {
          toolCallsById.set(item.id, call);
        }
        toolCallsById.set(`function_call:${item.order ?? event?.output_index ?? 0}`, call);
        if (eventType === "response.output_item.added" && isLongToolArgumentName(call.name)) {
          onToolArgsDelta?.({
            id: call.call_id || call.id || event?.item_id || `function_call_${event?.output_index || 0}`,
            responseItemId: call.id || event?.item_id || "",
            index: event?.output_index,
            name: call.name,
            delta: "",
            arguments: call.arguments || ""
          });
        }
      }
    }
    return;
  }

  if (eventType === "response.output_text.delta") {
    const item = ensureResponsesOutputItem(outputItems, event?.item_id, event?.output_index, "message");
    const text = typeof event?.delta === "string" ? event.delta : "";
    if (text) {
      ensureMessageTextPart(item).text += text;
      onText?.(text);
    }
    return;
  }

  if (eventType === "response.function_call_arguments.delta") {
    const call = ensureFunctionCall(toolCallsById, outputItems, event?.item_id, event?.output_index);
    const delta = typeof event?.delta === "string" ? event.delta : "";
    call.arguments += delta;
    if (delta && isLongToolArgumentName(call.name)) {
      onToolArgsDelta?.({
        id: call.call_id || call.id || event?.item_id || `function_call_${event?.output_index || 0}`,
        responseItemId: call.id || event?.item_id || "",
        index: event?.output_index,
        name: call.name,
        delta,
        arguments: call.arguments
      });
    }
    return;
  }

  if (eventType === "response.function_call_arguments.done") {
    const call = ensureFunctionCall(toolCallsById, outputItems, event?.item_id, event?.output_index);
    if (typeof event?.arguments === "string") {
      call.arguments = event.arguments;
    }
    if (isLongToolArgumentName(call.name)) {
      onToolArgsDone?.({
        id: call.call_id || call.id || event?.item_id || `function_call_${event?.output_index || 0}`,
        responseItemId: call.id || event?.item_id || "",
        index: event?.output_index,
        name: call.name,
        arguments: call.arguments
      });
    }
    return;
  }

  if (eventType === "response.completed") {
    if (Array.isArray(event?.response?.output)) {
      event.response.output.forEach((item, index) => {
        const normalized = normalizeResponsesOutputItem(item, index);
        if (normalized) {
          outputItems.set(normalized.id || `${normalized.type}:${normalized.order}`, normalized);
          if (normalized.type === "function_call") {
            const call = mergeResponsesFunctionCall(toolCallsById, normalized.call_id || normalized.id, {
              id: normalized.id || "",
              call_id: normalized.call_id || normalized.id || "",
              name: normalized.name || "",
              arguments: normalized.arguments || ""
            });
            if (normalized.id) {
              toolCallsById.set(normalized.id, call);
            }
            toolCallsById.set(`function_call:${normalized.order ?? index}`, call);
          }
        }
      });
    }
  }
}

function normalizeResponsesOutputItem(item, order = 0) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "message") {
    return {
      id: item.id || `message_${order}`,
      order,
      type: "message",
      role: item.role || "assistant",
      content: Array.isArray(item.content) ? item.content.map(normalizeResponsesOutputContentPart).filter(Boolean) : []
    };
  }
  if (item.type === "function_call") {
    return {
      id: item.id || `function_call_${order}`,
      order,
      type: "function_call",
      call_id: item.call_id || item.id || `function_call_${order}`,
      name: item.name || "",
      arguments: typeof item.arguments === "string" ? item.arguments : ""
    };
  }
  return {
    id: item.id || `${item.type || "item"}_${order}`,
    order,
    ...item
  };
}

function normalizeResponsesOutputContentPart(part) {
  if (!part || typeof part !== "object") return null;
  if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
    return { type: "output_text", text: part.text };
  }
  return { ...part };
}

function ensureResponsesOutputItem(outputItems, itemId, order = 0, type = "message") {
  const key = itemId || `${type}:${order}`;
  if (!outputItems.has(key)) {
    outputItems.set(key, {
      id: itemId || key,
      order,
      type,
      role: "assistant",
      content: []
    });
  }
  return outputItems.get(key);
}

function ensureMessageTextPart(item) {
  if (!Array.isArray(item.content)) item.content = [];
  let textPart = item.content.find(part => part?.type === "output_text");
  if (!textPart) {
    textPart = { type: "output_text", text: "" };
    item.content.push(textPart);
  }
  return textPart;
}

function ensureFunctionCall(toolCallsById, outputItems, itemId, order = 0) {
  const item = ensureResponsesFunctionCallOutputItem(outputItems, itemId, order);
  item.type = "function_call";
  item.call_id = item.call_id || item.id || `function_call_${order}`;
  item.name = item.name || "";
  item.arguments = item.arguments || "";

  const key = item.call_id;
  const call = mergeResponsesFunctionCall(toolCallsById, key, {
    id: item.id || "",
    call_id: item.call_id,
    name: item.name || "",
    arguments: item.arguments || ""
  });
  if (item.id) {
    toolCallsById.set(item.id, call);
  }
  toolCallsById.set(`function_call:${order ?? 0}`, call);
  return call;
}

function ensureResponsesFunctionCallOutputItem(outputItems, itemId, order = 0) {
  const item = ensureResponsesOutputItem(outputItems, itemId, order, "function_call");
  if (item?.type === "function_call") return item;
  const fallbackKey = `function_call:${order ?? 0}`;
  const fallback = outputItems.get(fallbackKey);
  if (fallback?.type === "function_call") return fallback;
  for (const candidate of outputItems.values()) {
    if (candidate?.type === "function_call" && candidate.order === order) return candidate;
  }
  return item;
}

function mergeResponsesFunctionCall(toolCallsById, key, nextCall) {
  const existing =
    toolCallsById.get(key) ||
    (nextCall?.id ? toolCallsById.get(nextCall.id) : null) ||
    (nextCall?.call_id ? toolCallsById.get(nextCall.call_id) : null);
  if (existing) {
    existing.id = existing.id || nextCall.id || "";
    existing.call_id = existing.call_id || nextCall.call_id || existing.id || "";
    existing.name = existing.name || nextCall.name || "";
    if (typeof nextCall.arguments === "string" && nextCall.arguments.length > existing.arguments.length) {
      existing.arguments = nextCall.arguments;
    } else {
      existing.arguments = existing.arguments || nextCall.arguments || "";
    }
    toolCallsById.set(key, existing);
    return existing;
  }
  const created = {
    id: nextCall.id || "",
    call_id: nextCall.call_id || nextCall.id || "",
    name: nextCall.name || "",
    arguments: nextCall.arguments || ""
  };
  toolCallsById.set(key, created);
  return created;
}

function dedupeResponsesFunctionCalls(calls) {
  const seen = new Set();
  const result = [];
  for (const call of calls || []) {
    if (!call) continue;
    const key = call.call_id || call.id || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(call);
  }
  return result;
}

export function normalizeResponsesMessageContent(content, role = "user") {
  if (typeof content === "string") {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  }
  if (Array.isArray(content)) {
    const blocks = content.flatMap(block => {
      if (!block || typeof block !== "object") return [];
      if (block.type === "text" && typeof block.text === "string") {
        return [{ type: role === "assistant" ? "output_text" : "input_text", text: block.text }];
      }
      if (block.type === "image_url" && block.image_url?.url) {
        return [{ type: "input_image", image_url: block.image_url.url }];
      }
      if ((block.type === "output_text" || block.type === "input_text") && typeof block.text === "string") {
        return [{ type: block.type, text: block.text }];
      }
      return [];
    });
    return blocks.length > 0 ? blocks : [{ type: role === "assistant" ? "output_text" : "input_text", text: "" }];
  }
  if (content == null) {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: "" }];
  }
  return [{ type: role === "assistant" ? "output_text" : "input_text", text: String(content) }];
}

export function extractOpenAIResponsesUsage(event) {
  if (!event || typeof event !== "object") return null;
  return firstUsageObject(
    event.usage,
    event.response?.usage,
    event.item?.usage,
    event.output?.[0]?.usage
  );
}
