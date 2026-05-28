import { API_TYPES, normalizeApiType } from "../../../../api/llm";
import { buildPlainApiMessage, shouldOmitThinkingFromRequests } from "./_helpers";
import { buildOpenAIToolResultContent, buildOpenAIToolResultImageUserMessage } from "../messages/toolResults";


export function buildOpenAIAssistantMessageFromAnthropic(msg, options = {}) {
  if (!Array.isArray(msg.content)) return buildOpenAIAssistantMessageForApi(msg, options);

  const omitThinking = shouldOmitThinkingFromRequests(options);
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const block of msg.content) {
    if (!block) continue;
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (!omitThinking && block.type === "thinking" && block.thinking) {
      reasoningParts.push(block.thinking);
    } else if (block.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id || `toolcall_${block.name}_${Date.now()}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  const apiMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
  if (reasoningParts.length > 0) {
    apiMessage.reasoning_content = reasoningParts.join("");
  }
  return copyOpenAIProviderMetadataForApi(msg, copyOpenAIReasoningFieldsForApi(msg, apiMessage, options), options);
}

export function buildOpenAIAssistantMessageForApi(msg, options = {}) {
  if (Array.isArray(msg.content)) {
    return buildOpenAIAssistantMessageFromAnthropic(msg, options);
  }

  const apiMessage = {
    role: "assistant",
    content: msg.content ?? null
  };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    apiMessage.tool_calls = msg.tool_calls.map(normalizeOpenAIToolCallForApi).filter(Boolean);
  }
  return copyOpenAIProviderMetadataForApi(msg, copyOpenAIReasoningFieldsForApi(msg, apiMessage, options), options);
}

export function normalizeOpenAIToolCallForApi(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const name = toolCall.function?.name || toolCall.name || "";
  const rawArguments = toolCall.function?.arguments ?? toolCall.arguments ?? "{}";
  const args = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {});
  if (!name) return null;
  return {
    id: toolCall.id || toolCall.call_id || `toolcall_${name}_${Date.now()}`,
    type: "function",
    function: {
      name,
      arguments: args
    }
  };
}

export function copyOpenAIReasoningFieldsForApi(source, target, options = {}) {
  if (shouldOmitThinkingFromRequests(options)) return target;

  const reasoningContent = getOpenAIReasoningContentForApi(source);
  if (reasoningContent != null) {
    target.reasoning_content = reasoningContent;
  }

  for (const field of ["reasoning", "reasoning_details", "thinking"]) {
    const value = source?.[field];
    if (value == null) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    target[field] = value;
  }
  return target;
}

export function getOpenAIReasoningContentForApi(msg) {
  for (const field of ["reasoning_content", "reasoning", "thinking"]) {
    const value = msg?.[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function copyOpenAIProviderMetadataForApi(source, target, options = {}) {
  if (shouldOmitThinkingFromRequests(options)) return target;
  if (normalizeApiType(options.apiType) !== API_TYPES.OPENAI_RESPONSES) return target;
  if (Array.isArray(source?._responsesReasoningItems) && source._responsesReasoningItems.length > 0) {
    target._responsesReasoningItems = source._responsesReasoningItems;
  }
  return target;
}

export function buildOpenAIApiMessages(messages, options = {}) {
  const apiMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "error") continue;

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const followingToolMessages = [];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        followingToolMessages.push(messages[j]);
        j += 1;
      }

      apiMessages.push(buildOpenAIAssistantMessageForApi(msg, options));
      for (const toolMsg of followingToolMessages) {
        apiMessages.push(buildOpenAIToolMessageForApi(toolMsg, options));
        if (!isOpenAIResponsesRequest(options)) {
          const imageUserMessage = buildOpenAIToolResultImageUserMessage(toolMsg, options);
          if (imageUserMessage) apiMessages.push(imageUserMessage);
        }
      }

      i = j - 1;
      continue;
    }

    if (msg.role === "assistant") {
      apiMessages.push(buildOpenAIAssistantMessageForApi(msg, options));
      continue;
    }

    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const openaiContent = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            openaiContent.push({ type: "text", text: block.text });
          } else if (block.type === "file") {
            openaiContent.push({ type: "text", text: `[Attached file: ${block.fileName}]\n${block.text}` });
          } else if (block.type === "image" && block.source && options.supportsImageInput !== false) {
            const dataUrl = buildImageBlockDataUrlForApi(block);
            if (dataUrl) openaiContent.push({ type: "image_url", image_url: { url: dataUrl, detail: "low" } });
          }
        }
        apiMessages.push({ role: "user", content: openaiContent });
        continue;
      }
    }

    if (msg.role === "tool") {
      apiMessages.push(buildOpenAIToolMessageForApi(msg, options));
      if (!isOpenAIResponsesRequest(options)) {
        const imageUserMessage = buildOpenAIToolResultImageUserMessage(msg, options);
        if (imageUserMessage) apiMessages.push(imageUserMessage);
      }
      continue;
    }

    apiMessages.push(buildPlainApiMessage(msg, options));
  }

  return apiMessages;
}

function buildOpenAIToolMessageForApi(msg, options = {}) {
  const apiMessage = {
    role: "tool",
    tool_call_id: msg.tool_call_id,
    content: buildOpenAIToolResultContent(msg, options)
  };
  if (isOpenAIResponsesRequest(options)) {
    copyResponsesToolImageFieldsForApi(msg, apiMessage);
  }
  return apiMessage;
}

function isOpenAIResponsesRequest(options = {}) {
  return normalizeApiType(options.apiType) === API_TYPES.OPENAI_RESPONSES;
}

function copyResponsesToolImageFieldsForApi(source, target) {
  if (source?.displayImageUrl) target.displayImageUrl = source.displayImageUrl;
  if (Array.isArray(source?.displayImages) && source.displayImages.length > 0) {
    target.displayImages = source.displayImages;
  }
}

function buildImageBlockDataUrlForApi(block) {
  if (block?.source?.type !== "base64") return "";
  if (!block.source.media_type || !block.source.data) return "";
  return `data:${block.source.media_type};base64,${block.source.data}`;
}
