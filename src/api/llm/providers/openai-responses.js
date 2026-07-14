import { resolveLlmRequestUrl } from "../core/endpoint";
import { API_TYPES } from "../core/config";
import { buildFirstPacketTimeoutError, createFirstPacketTimeoutState, createLlmStreamError, getFirstPacketTimeoutMs, isAbortError, mergeUsage } from "../core/shared";
import { getTools } from "../tools/definitions";
import { buildOpenAICacheFields, firstUsageObject } from "./openai-chat-completions";
import { isLongToolArgumentName } from "../core/longToolArgs";
import { buildOpenAIResponsesReasoningFields, normalizeReasoningEffort } from "../core/reasoning";
import { buildLlmAuthHeaders } from "../core/modelProfiles";

export async function streamOpenAIResponsesAttempt(config, messages, signal, { onText, onThinking, onDone, onToolArgsDelta, onToolArgsDone, onRequestBodySize }, mcpTools = [], options = {}) {
  const tools = getTools(API_TYPES.OPENAI_RESPONSES, mcpTools, options);
  const url = resolveLlmRequestUrl(API_TYPES.OPENAI_RESPONSES, config.baseUrl);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    const { instructions, input } = buildResponsesRequestInput(messages, {
      omitThinkingFromRequests: config.omitThinkingFromRequests === true || options.omitThinkingFromRequests === true
    });
    const requestBody = {
      model: config.model,
      input,
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
      ...buildResponsesMaxOutputTokens(options),
      ...(instructions ? { instructions } : {}),
      ...buildOpenAIResponsesReasoningFields(config),
      ...buildOpenAIResponsesIncludeFields(config, options),
      ...buildOpenAICacheFields(options)
    };
    const requestBodyText = JSON.stringify(requestBody);
    onRequestBodySize?.({
      bytes: measureUtf8Bytes(requestBodyText),
      apiType: API_TYPES.OPENAI_RESPONSES,
      model: config.model || ""
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildLlmAuthHeaders(config)
      },
      body: requestBodyText,
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
          applyResponsesStreamEvent(event, outputItems, toolCallsById, { onText, onThinking, onToolArgsDelta, onToolArgsDone });
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
    const reasoning = orderedItems
      .map(extractResponsesReasoningText)
      .filter(Boolean)
      .join("\n\n");
    const reasoningItems = orderedItems
      .map(normalizeResponsesReasoningInputItem)
      .filter(Boolean);

    onDone?.({
      role: "assistant",
      content: textParts.join("") || null,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningItems.length > 0 ? { response_reasoning_items: reasoningItems } : {}),
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

function buildOpenAIResponsesIncludeFields(config = {}, options = {}) {
  const effort = normalizeReasoningEffort(config.reasoningEffort);
  if (!effort || options.enableBetaFeatures === false) return {};
  return { include: ["reasoning.encrypted_content"] };
}

function buildResponsesMaxOutputTokens(options = {}) {
  const maxTokens = normalizeStreamMaxTokens(options.maxTokens);
  return maxTokens ? { max_output_tokens: maxTokens } : {};
}

function normalizeStreamMaxTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(8192, Math.floor(number));
}

export function buildResponsesRequestInput(messages, options = {}) {
  const instructionsParts = [];
  const input = [];
  const omitThinking = shouldOmitThinkingFromRequests(options);

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
        output: buildResponsesFunctionCallOutput(msg, options)
      });
      continue;
    }

    if (msg.role === "assistant") {
      if (!omitThinking) {
        input.push(...normalizeResponsesReasoningInputItems(msg._responsesReasoningItems));
      }

      if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: normalizeResponsesMessageContent(msg.content, "assistant", options)
        });
        continue;
      }

      const text = extractPlainMessageText(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }]
        });
      }
      for (const tc of msg.tool_calls) {
        input.push(buildResponsesFunctionCallInputItem(tc));
      }
      continue;
    }

    input.push({
      type: "message",
      role: msg.role || "user",
      content: normalizeResponsesMessageContent(msg.content, msg.role || "user", options)
    });
  }

  return {
    instructions: instructionsParts.join("\n\n").trim() || undefined,
    input: input.map(sanitizeResponsesRequestInputItem).filter(Boolean)
  };
}

function shouldOmitThinkingFromRequests(options = {}) {
  return options.omitThinkingFromRequests === true;
}

function sanitizeResponsesRequestInputItem(item) {
  if (!item || typeof item !== "object") return null;

  if (item.type === "reasoning" || item.type === "thinking") {
    return normalizeResponsesReasoningInputItem(item);
  }

  if (item.type === "function_call") {
    return {
      type: "function_call",
      id: item.id || buildSyntheticResponsesFunctionCallItemId(item.call_id, item.name, item.arguments),
      call_id: item.call_id || buildSyntheticResponsesToolCallId(item.name, item.arguments),
      name: item.name || "",
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
    };
  }

  if (item.type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: item.call_id || "",
      output: item.output
    };
  }

  if (item.type === "message") {
    return {
      type: "message",
      role: item.role || "user",
      content: normalizeResponsesMessageContent(item.content, item.role || "user")
    };
  }

  const sanitized = { ...item };
  delete sanitized.status;
  delete sanitized.order;
  return sanitized;
}

function measureUtf8Bytes(text) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(String(text ?? "")).length;
  }
  return new Blob([String(text ?? "")]).size;
}

function buildResponsesFunctionCallOutput(msg, options = {}) {
  const supportsImageInput = options.supportsImageInput !== false;
  const supportsToolImageInput = getSupportsToolImageInput(options);
  const output = normalizeResponsesFunctionCallOutput(msg.content, { supportsImageInput, supportsToolImageInput });
  const images = supportsToolImageInput ? collectResponsesToolOutputImages(msg) : [];
  if (images.length === 0) return output;

  const blocks = Array.isArray(output)
    ? output
    : [{ type: "input_text", text: String(output ?? "") }];
  const existingImageUrls = new Set(
    blocks
      .filter(block => block?.type === "input_image" && typeof block.image_url === "string")
      .map(block => block.image_url)
  );
  return [
    ...blocks,
    ...images.filter(image => !existingImageUrls.has(image.image_url))
  ];
}

function normalizeResponsesFunctionCallOutput(output, options = {}) {
  const supportsImageInput = options.supportsImageInput !== false;
  const supportsToolImageInput = getSupportsToolImageInput(options);
  if (typeof output === "string") {
    const parsed = tryParseJson(output);
    if (parsed.ok) {
      const normalized = normalizeResponsesFunctionCallOutput(parsed.value, options);
      if (Array.isArray(parsed.value) || Array.isArray(normalized)) return normalized;
    }
    return output;
  }
  if (Array.isArray(output)) {
    const blocks = output.flatMap(block => normalizeResponsesFunctionCallOutputBlock(block, { supportsImageInput, supportsToolImageInput }));
    if (supportsToolImageInput && blocks.some(block => block.type === "input_image" || block.type === "input_file")) {
      return blocks;
    }
    const text = blocks
      .map(block => block?.text || block?.file_id || block?.file_url || "")
      .filter(Boolean)
      .join("\n");
    return text || JSON.stringify(output ?? "");
  }
  return typeof output === "object" && output != null ? JSON.stringify(output) : String(output ?? "");
}

function normalizeResponsesFunctionCallOutputBlock(block, options = {}) {
  const supportsToolImageInput = getSupportsToolImageInput(options);
  if (typeof block === "string") return [{ type: "input_text", text: block }];
  if (!block || typeof block !== "object") return [];

  if ((block.type === "text" || block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
    return [{ type: "input_text", text: block.text }];
  }

  if ((block.type === "image_url" || block.type === "input_image" || block.type === "output_image") && typeof (block.image_url?.url || block.image_url) === "string") {
    if (!supportsToolImageInput) return [{ type: "input_text", text: "[omitted image from previous tool output]" }];
    return [{
      type: "input_image",
      image_url: block.image_url?.url || block.image_url,
      detail: block.image_url?.detail || block.detail || "low"
    }];
  }

  if (block.type === "image" && block.source?.type === "base64" && block.source?.media_type && block.source?.data) {
    if (!supportsToolImageInput) return [{ type: "input_text", text: "[omitted image from previous tool output]" }];
    return [{
      type: "input_image",
      image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      detail: block.detail || "low"
    }];
  }

  if ((block.type === "input_file" || block.type === "output_file") && (block.file_id || block.file_url || block.file_data)) {
    return [{
      type: "input_file",
      ...(block.file_id ? { file_id: block.file_id } : {}),
      ...(block.file_url ? { file_url: block.file_url } : {}),
      ...(block.file_data ? { file_data: block.file_data } : {}),
      ...(block.filename ? { filename: block.filename } : {})
    }];
  }

  return [{ type: "input_text", text: JSON.stringify(block) }];
}

function getSupportsToolImageInput(options = {}) {
  if (options.supportsImageInput === false) return false;
  if (Object.prototype.hasOwnProperty.call(options, "supportsToolImageInput")) {
    return options.supportsToolImageInput === true;
  }
  return true;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, value: null };
  }
}

function collectResponsesToolOutputImages(msg) {
  const sources = Array.isArray(msg?.displayImages) && msg.displayImages.length > 0
    ? msg.displayImages.map(image => image?.url)
    : [msg?.displayImageUrl];
  const seen = new Set();
  const images = [];
  for (const source of sources) {
    const imageUrl = String(source || "").trim();
    if (!/^data:[^;]+;base64,/i.test(imageUrl) || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    images.push({ type: "input_image", image_url: imageUrl, detail: "low" });
  }
  return images;
}

function buildResponsesFunctionCallInputItem(toolCall = {}) {
  const name = toolCall.function?.name || toolCall.name || "";
  const args = toolCall.function?.arguments || toolCall.arguments || "{}";
  const callId = toolCall.call_id || toolCall.id || buildSyntheticResponsesToolCallId(name, args);
  const responseItemId = toolCall.response_item_id ||
    (toolCall.call_id && toolCall.id && toolCall.id !== toolCall.call_id ? toolCall.id : "") ||
    buildSyntheticResponsesFunctionCallItemId(callId, name, args);
  const item = {
    type: "function_call",
    call_id: callId,
    id: responseItemId,
    name,
    arguments: args
  };
  return item;
}

function buildSyntheticResponsesFunctionCallItemId(callId, name = "", args = "") {
  const suffix = sanitizeResponsesItemIdSuffix(callId) || hashResponsesIdSource(`${name}:${args}`);
  return `fc_${suffix}`;
}

function buildSyntheticResponsesToolCallId(name = "", args = "") {
  return `call_${hashResponsesIdSource(`${name}:${args}`)}`;
}

function sanitizeResponsesItemIdSuffix(value) {
  return String(value || "")
    .trim()
    .replace(/^fc_/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function hashResponsesIdSource(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

function applyResponsesStreamEvent(event, outputItems, toolCallsById, { onText, onThinking, onToolArgsDelta, onToolArgsDone } = {}) {
  const eventType = String(event?.type || "");
  const encryptedReasoningDelta = extractResponsesEncryptedReasoningDelta(event);
  if (encryptedReasoningDelta) {
    const item = ensureResponsesReasoningItem(outputItems, event?.item_id, event?.output_index);
    item.encrypted_content = (item.encrypted_content || "") + encryptedReasoningDelta;
    return;
  }

  const reasoningDelta = extractResponsesReasoningDelta(event);
  if (reasoningDelta) {
    const item = ensureResponsesReasoningItem(outputItems, event?.item_id, event?.output_index);
    ensureResponsesReasoningTextPart(item).text += reasoningDelta;
    onThinking?.(reasoningDelta, { eventType, provider: API_TYPES.OPENAI_RESPONSES });
    return;
  }

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

export function extractResponsesReasoningDelta(event) {
  const eventType = String(event?.type || "").toLowerCase();
  if (!eventType.includes("reasoning") && !eventType.includes("thinking")) return "";
  if (eventType.includes("encrypted")) return "";
  if (!eventType.includes(".delta")) return "";
  return extractResponsesReasoningValue(event?.delta) ||
    extractResponsesReasoningValue(event?.text) ||
    extractResponsesReasoningValue(event?.summary) ||
    extractResponsesReasoningValue(event?.content);
}

export function extractResponsesEncryptedReasoningDelta(event) {
  const eventType = String(event?.type || "").toLowerCase();
  if (!eventType.includes("encrypted")) return "";
  if (!eventType.includes("reasoning") && !eventType.includes("thinking")) return "";
  if (!eventType.includes(".delta")) return "";
  return extractResponsesEncryptedReasoningValue(event?.delta) ||
    extractResponsesEncryptedReasoningValue(event?.encrypted_content) ||
    extractResponsesEncryptedReasoningValue(event?.content);
}

export function extractResponsesReasoningText(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type !== "reasoning" && item.type !== "thinking") return "";
  return extractResponsesReasoningValue(item);
}

function extractResponsesReasoningValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractResponsesReasoningValue).filter(Boolean).join("");
  if (value && typeof value === "object") {
    return [
      value.text,
      value.summary_text,
      value.reasoning,
      value.reasoning_content,
      value.thinking,
      value.summary,
      value.content,
      value.output_text
    ].map(extractResponsesReasoningValue).filter(Boolean).join("");
  }
  return "";
}

function extractResponsesEncryptedReasoningValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractResponsesEncryptedReasoningValue).filter(Boolean).join("");
  if (value && typeof value === "object") {
    return extractResponsesEncryptedReasoningValue(value.encrypted_content) ||
      extractResponsesEncryptedReasoningValue(value.content);
  }
  return "";
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
  if (item.type === "reasoning" || item.type === "thinking") {
    return normalizeResponsesReasoningOutputItem(item, order);
  }
  return {
    id: item.id || `${item.type || "item"}_${order}`,
    order,
    ...item
  };
}

function normalizeResponsesReasoningOutputItem(item, order = 0) {
  const normalized = {
    id: item.id || `reasoning_${order}`,
    order,
    type: item.type
  };
  if (item.status) normalized.status = item.status;
  if (Array.isArray(item.summary)) normalized.summary = item.summary.map(normalizeResponsesReasoningSummaryPart).filter(Boolean);
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    normalized.encrypted_content = item.encrypted_content;
  }
  return normalized;
}

function normalizeResponsesReasoningSummaryPart(part) {
  if (!part || typeof part !== "object") return null;
  if ((part.type === "summary_text" || part.type === "text") && typeof part.text === "string") {
    return { type: "summary_text", text: part.text };
  }
  return { ...part };
}

function normalizeResponsesReasoningInputItems(items) {
  return Array.isArray(items) ? items.map(normalizeResponsesReasoningInputItem).filter(Boolean) : [];
}

export function normalizeResponsesReasoningInputItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type !== "reasoning" && item.type !== "thinking") return null;

  const normalized = { type: item.type };
  if (typeof item.id === "string" && item.id.length > 0) normalized.id = item.id;
  if (Array.isArray(item.summary)) {
    const summary = item.summary.map(normalizeResponsesReasoningSummaryPart).filter(Boolean);
    normalized.summary = summary;
  }
  if (!Array.isArray(normalized.summary)) normalized.summary = [];
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    normalized.encrypted_content = item.encrypted_content;
  }

  return normalized.id || normalized.summary || normalized.encrypted_content ? normalized : null;
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

function ensureResponsesReasoningItem(outputItems, itemId, order = 0) {
  const item = ensureResponsesOutputItem(outputItems, itemId, order, "reasoning");
  item.type = "reasoning";
  if (!Array.isArray(item.summary)) item.summary = [];
  return item;
}

function ensureResponsesReasoningTextPart(item) {
  if (!Array.isArray(item.summary)) item.summary = [];
  let textPart = item.summary.find(part => (part?.type === "summary_text" || part?.type === "text") && typeof part.text === "string");
  if (!textPart) {
    textPart = { type: "summary_text", text: "" };
    item.summary.push(textPart);
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

export function normalizeResponsesMessageContent(content, role = "user", options = {}) {
  const supportsImageInput = options.supportsImageInput !== false;
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
        if (!supportsImageInput) return [];
        return [{ type: "input_image", image_url: block.image_url.url }];
      }
      if (block.type === "input_image" && typeof block.image_url === "string") {
        if (!supportsImageInput) return [];
        return [{
          type: "input_image",
          image_url: block.image_url,
          ...(block.detail ? { detail: block.detail } : {})
        }];
      }
      if (block.type === "image") {
        if (!supportsImageInput) return [];
        const dataUrl = buildResponsesImageBlockDataUrl(block);
        if (dataUrl) return [{ type: "input_image", image_url: dataUrl }];
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

function buildResponsesImageBlockDataUrl(block) {
  if (block?.source?.type !== "base64") return "";
  if (!block.source.media_type || !block.source.data) return "";
  return `data:${block.source.media_type};base64,${block.source.data}`;
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
