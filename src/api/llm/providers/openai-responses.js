import { resolveLlmRequestUrl } from "../core/endpoint";
import { API_TYPES } from "../core/config";
import { buildFirstPacketTimeoutError, createFirstPacketTimeoutState, createLlmStreamError, getFirstPacketTimeoutMs, isAbortError, mergeUsage } from "../core/shared";
import { getTools } from "../tools/definitions";
import { buildOpenAICacheFields, firstUsageObject } from "./openai-chat-completions";
import { isLongToolArgumentName } from "../core/longToolArgs";
import { buildOpenAIResponsesReasoningFields, normalizeReasoningEffort } from "../core/reasoning";
import { buildLlmAuthHeaders } from "../core/modelProfiles";

export async function streamOpenAIResponsesAttempt(config, messages, signal, { onText, onThinking, onDone, onToolArgsDelta, onToolArgsDone, onNativeWebSearch, onRequestBodySize }, mcpTools = [], options = {}) {
  const tools = [
    ...(config.nativeWebSearch === true ? [{ type: "web_search" }] : []),
    ...getTools(API_TYPES.OPENAI_RESPONSES, mcpTools, options)
  ];
  const url = resolveLlmRequestUrl(API_TYPES.OPENAI_RESPONSES, config.baseUrl);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    const { instructions, input } = buildResponsesRequestInput(messages, {
      omitThinkingFromRequests: config.omitThinkingFromRequests === true || options.omitThinkingFromRequests === true,
      nativeWebSearch: config.nativeWebSearch === true
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
          applyResponsesStreamEvent(event, outputItems, toolCallsById, { onText, onThinking, onToolArgsDelta, onToolArgsDone, onNativeWebSearch });
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
            // Keep the Responses item ID as the local tool-call identity. call_id
            // may be reused by compatible providers in later response turns.
            id: tc.id || tc.call_id || `toolcall_${Date.now()}`,
            responseCallId: tc.call_id || tc.id || "",
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

    const messageContent = dedupeResponsesOutputTextParts(orderedItems
      .filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(Boolean));
    const citations = extractResponsesCitations(messageContent);
    const normalizedText = buildResponsesDisplayText(messageContent);
    const webSearches = orderedItems
      .filter(item => item.type === "web_search_call")
      .map(item => item.action)
      .filter(action => action && typeof action === "object");
    const webSearchItems = orderedItems
      .filter(item => item.type === "web_search_call")
      .map(item => ({
        id: item.id,
        type: item.type,
        status: item.status,
        action: item.action
      }));
    const reasoning = orderedItems
      .map(extractResponsesReasoningText)
      .filter(Boolean)
      .join("\n\n");
    const reasoningItems = orderedItems
      .map(normalizeResponsesReasoningInputItem)
      .filter(Boolean);
    const replayItems = orderedItems
      .filter(item => item.type === "reasoning" || item.type === "thinking" || item.type === "web_search_call")
      .map(item => item.type === "web_search_call" ? normalizeResponsesWebSearchInputItem(item) : normalizeResponsesReasoningInputItem(item))
      .filter(Boolean);

    onDone?.({
      role: "assistant",
      content: normalizedText || textParts.join("") || null,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningItems.length > 0 ? { response_reasoning_items: reasoningItems } : {}),
      ...(replayItems.length > 0 ? { response_replay_items: replayItems } : {}),
      ...(messageContent.length > 0 ? { response_content: messageContent } : {}),
      ...(citations.length > 0 ? { citations } : {}),
      ...(webSearches.length > 0 ? { web_searches: webSearches } : {}),
      ...(webSearchItems.length > 0 ? { web_search_items: webSearchItems } : {}),
      ...(usage ? { usage } : {}),
      ...(responseId ? { response_id: responseId } : {}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      _openaiToolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        response_call_id: tc.responseCallId || undefined,
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

export function extractResponsesCitations(content = []) {
  const citations = [];
  for (const part of content) {
    for (const annotation of part?.annotations || []) {
      if (annotation?.type !== "url_citation" || !annotation.url) continue;
      citations.push({
        type: "url_citation",
        title: annotation.title || annotation.url,
        url: annotation.url,
        startIndex: Number.isInteger(annotation.start_index) ? annotation.start_index : undefined,
        endIndex: Number.isInteger(annotation.end_index) ? annotation.end_index : undefined
      });
    }
  }
  return citations.filter((item, index, all) => all.findIndex(other => other.url === item.url) === index);
}

export function buildResponsesDisplayText(content = []) {
  return dedupeResponsesOutputTextParts(content)
    .filter(part => (part?.type === "output_text" || part?.type === "text") && typeof part.text === "string")
    .map(part => applyResponsesUrlCitations(part.text, part.annotations))
    .join("");
}

export function dedupeResponsesOutputTextParts(content = []) {
  const result = [];
  const indexByText = new Map();
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type !== "output_text" || typeof part.text !== "string") {
      result.push(part);
      continue;
    }
    const existingIndex = indexByText.get(part.text);
    if (existingIndex == null) {
      indexByText.set(part.text, result.length);
      result.push(part);
      continue;
    }
    const existing = result[existingIndex];
    result[existingIndex] = {
      ...existing,
      ...part,
      annotations: mergeResponsesAnnotations(existing?.annotations, part.annotations)
    };
  }
  return result;
}

function mergeResponsesAnnotations(first, second) {
  const result = [];
  const seen = new Set();
  for (const annotation of [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]) {
    if (!annotation || typeof annotation !== "object") continue;
    const key = `${annotation.type || ""}:${annotation.url || ""}:${annotation.start_index ?? ""}:${annotation.end_index ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...annotation });
  }
  return result;
}

export function applyResponsesUrlCitations(text, annotations = []) {
  const source = String(text || "");
  if (hasLeakedCitationMarker(source)) {
    return replaceLeakedCitationMarkers(source, annotations);
  }
  const replacements = (Array.isArray(annotations) ? annotations : [])
    .filter(annotation => annotation?.type === "url_citation" && annotation.url)
    .map(annotation => ({
      start: Number(annotation.start_index),
      end: Number(annotation.end_index),
      title: String(annotation.title || annotation.url),
      url: String(annotation.url)
    }))
    .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= source.length)
    .sort((a, b) => b.start - a.start);

  let result = source;
  for (const item of replacements) {
    const citedText = source.slice(item.start, item.end);
    const label = item.title || stripLeakedCitationMarkers(citedText).trim() || item.url;
    result = `${result.slice(0, item.start)}[${escapeMarkdownLinkLabel(label)}](${item.url})${result.slice(item.end)}`;
  }
  return stripLeakedCitationMarkers(result);
}

function stripLeakedCitationMarkers(text) {
  return String(text || "")
    .replace(/\[?(?:(?:\uE200)?cite(?:\uE202|\[)?)?turn\d+(?:search|news)\d+(?:\uE201|\])?/gi, "")
    .replace(/\[?cite(?:turn\d+(?:search|news)\d+)?\]?/gi, "")
    .replace(/[\uE000-\uF8FF]/g, "");
}

function hasLeakedCitationMarker(text) {
  return /\[?(?:(?:\uE200)?cite(?:\uE202|\[)?)?turn\d+(?:search|news)\d+/i.test(String(text || ""));
}

function replaceLeakedCitationMarkers(text, annotations = []) {
  const usableAnnotations = (Array.isArray(annotations) ? annotations : [])
    .filter(annotation => annotation?.type === "url_citation" && annotation.url);
  let annotationIndex = 0;
  const annotationsByToken = new Map();
  const replaced = String(text || "").replace(
    /\[?(?:(?:\uE200)?cite(?:\uE202|\[)?)?(turn\d+(?:search|news)\d+)(?:\uE201|\])?/gi,
    (_match, rawToken) => {
      const token = String(rawToken || "").toLowerCase();
      let annotation = annotationsByToken.get(token);
      if (!annotation) {
        annotation = usableAnnotations[annotationIndex++];
        if (annotation) annotationsByToken.set(token, annotation);
      }
      if (!annotation) return "";
      const title = escapeMarkdownLinkLabel(annotation.title || annotation.url);
      return `[${title}](${annotation.url})`;
    }
  );
  return promoteReferenceListTitles(stripLeakedCitationMarkers(replaced));
}

function promoteReferenceListTitles(text) {
  return String(text || "").replace(
    /^(\s*[-*+]\s+)(.+?)[：:]\s*\(?\[[^\]]+\]\((https?:\/\/[^\s)]+)\)\)?\s*$/gm,
    (_match, prefix, title, url) => `${prefix}[${escapeMarkdownLinkLabel(title.trim())}](${url})`
  );
}

function escapeMarkdownLinkLabel(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
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
        call_id: msg.response_call_id || msg.tool_call_id,
        output: buildResponsesFunctionCallOutput(msg, options)
      });
      continue;
    }

    if (msg.role === "assistant") {
      const replayItems = options.nativeWebSearch === true && Array.isArray(msg._responsesReplayItems)
        ? msg._responsesReplayItems.filter(item => !omitThinking || item?.type === "web_search_call")
        : null;
      if (replayItems) {
        input.push(...replayItems);
      } else if (!omitThinking) {
        input.push(...normalizeResponsesReasoningInputItems(msg._responsesReasoningItems));
      }

      if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
        const storedResponsesContent = options.nativeWebSearch === true && Array.isArray(msg._responsesContent)
          ? msg._responsesContent
          : msg.content;
        const content = dedupeResponsesOutputTextParts(
          normalizeResponsesMessageContent(storedResponsesContent, "assistant", options)
        );
        const trace = options.nativeWebSearch === true ? formatWebSearchTrace(msg.web_searches) : "";
        const searchItems = !replayItems && options.nativeWebSearch === true && Array.isArray(msg.web_search_items)
          ? msg.web_search_items
          : [];
        input.push(...searchItems);
        input.push({
          type: "message",
          role: "assistant",
          content: trace ? [...content, { type: "input_text", text: `\n\n[Previous web search actions]\n${trace}` }] : content
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

function formatWebSearchTrace(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "";
  return actions.flatMap((action, index) => {
    if (action?.type === "search") {
      const queries = [
        ...(Array.isArray(action.query) ? action.query : [action.query]),
        ...(Array.isArray(action.queries) ? action.queries : [action.queries])
      ].map(value => String(value || "").trim()).filter(Boolean);
      return queries.map((query, queryIndex) => `${index + 1}.${queryIndex + 1}. search: ${query}`);
    }
    if (action?.type === "open_page") return `${index + 1}. fetch: ${action.url || ""}`;
    return `${index + 1}. ${action?.type || "web_search"}`;
  }).join("\n");
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

  if (item.type === "web_search_call") {
    return normalizeResponsesWebSearchInputItem(item);
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

function normalizeResponsesWebSearchInputItem(item) {
  if (!item || item.type !== "web_search_call") return null;
  return {
    type: "web_search_call",
    id: item.id || "",
    status: item.status || "completed",
    action: item.action || {}
  };
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
  const callId = toolCall.response_call_id || toolCall.call_id || toolCall.id || buildSyntheticResponsesToolCallId(name, args);
  const responseItemId = (toolCall.response_call_id && toolCall.id ? toolCall.id : "") ||
    toolCall.response_item_id ||
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

function applyResponsesStreamEvent(event, outputItems, toolCallsById, { onText, onThinking, onToolArgsDelta, onToolArgsDone, onNativeWebSearch } = {}) {
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
      storeResponsesOutputItem(outputItems, item);
      if (item.type === "web_search_call") {
        onNativeWebSearch?.({ id: item.id, status: item.status || "completed", action: item.action || null });
      }
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

  if (eventType === "response.output_text.annotation.added") {
    const item = ensureResponsesOutputItem(outputItems, event?.item_id, event?.output_index, "message");
    const textPart = ensureMessageTextPart(item);
    if (!Array.isArray(textPart.annotations)) textPart.annotations = [];
    const annotation = event?.annotation;
    if (annotation && typeof annotation === "object") {
      const index = Number.isInteger(event?.annotation_index) ? event.annotation_index : textPart.annotations.length;
      textPart.annotations[index] = { ...annotation };
    }
    return;
  }

  if (eventType === "response.output_text.done") {
    const item = ensureResponsesOutputItem(outputItems, event?.item_id, event?.output_index, "message");
    const textPart = ensureMessageTextPart(item);
    if (typeof event?.text === "string") textPart.text = event.text;
    if (Array.isArray(event?.annotations)) {
      textPart.annotations = event.annotations.map(annotation => ({ ...annotation }));
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
          storeResponsesOutputItem(outputItems, normalized);
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
    return {
      ...part,
      type: "output_text",
      text: part.text,
      annotations: Array.isArray(part.annotations) ? part.annotations.map(annotation => ({ ...annotation })) : []
    };
  }
  return { ...part };
}

function storeResponsesOutputItem(outputItems, incoming) {
  if (!incoming) return null;
  let merged = incoming;
  for (const [key, existing] of outputItems.entries()) {
    if (existing?.type !== incoming.type || existing?.order !== incoming.order) continue;
    merged = mergeResponsesOutputItems(existing, merged);
    outputItems.delete(key);
  }
  outputItems.set(merged.id || `${merged.type}:${merged.order}`, merged);
  return merged;
}

function mergeResponsesOutputItems(existing, incoming) {
  if (incoming.type !== "message") return { ...existing, ...incoming };
  const existingContent = Array.isArray(existing.content) ? existing.content : [];
  const incomingContent = Array.isArray(incoming.content) ? incoming.content : [];
  const contentLength = Math.max(existingContent.length, incomingContent.length);
  const content = [];
  for (let index = 0; index < contentLength; index += 1) {
    const previous = existingContent[index];
    const next = incomingContent[index];
    if (!previous) {
      content.push(next);
      continue;
    }
    if (!next) {
      content.push(previous);
      continue;
    }
    const previousText = typeof previous.text === "string" ? previous.text : "";
    const nextText = typeof next.text === "string" ? next.text : "";
    content.push({
      ...previous,
      ...next,
      text: nextText.length >= previousText.length ? nextText : previousText,
      annotations: Array.isArray(next.annotations) && next.annotations.length > 0
        ? next.annotations
        : (Array.isArray(previous.annotations) ? previous.annotations : [])
    });
  }
  return { ...existing, ...incoming, content };
}

function ensureResponsesOutputItem(outputItems, itemId, order = 0, type = "message") {
  const key = itemId || `${type}:${order}`;
  if (!outputItems.has(key)) {
    const existing = [...outputItems.values()].find(item => item?.type === type && item?.order === order);
    if (existing) return existing;
  }
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
        return [{
          type: block.type,
          text: block.text,
          ...(Array.isArray(block.annotations) ? { annotations: block.annotations.map(annotation => ({ ...annotation })) } : {})
        }];
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
