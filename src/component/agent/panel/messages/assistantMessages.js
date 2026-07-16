import { API_TYPES, normalizeApiType } from "../../../../api/llm";

export function buildFinalAssistantMessage(apiType, model, textContent, doneMsg = {}) {
  if (apiType === "anthropic" && Array.isArray(doneMsg.content)) {
    return copyAssistantUsageFields(apiType, model, doneMsg, copyAnthropicThinkingFields(doneMsg, { role: "assistant", content: doneMsg.content }));
  }

  const message = {
    role: "assistant",
    content: normalizeApiType(apiType) === API_TYPES.OPENAI_RESPONSES
      ? (doneMsg.content || textContent || "")
      : (textContent || doneMsg.content || "")
  };
  if (doneMsg?.response_id) {
    message._responsesResponseId = doneMsg.response_id;
  }
  if (Array.isArray(doneMsg?.response_content) && doneMsg.response_content.length > 0) {
    message._responsesContent = doneMsg.response_content;
  }
  if (Array.isArray(doneMsg?.citations) && doneMsg.citations.length > 0) message.citations = doneMsg.citations;
  if (Array.isArray(doneMsg?.web_searches) && doneMsg.web_searches.length > 0) message.web_searches = doneMsg.web_searches;
  if (Array.isArray(doneMsg?.web_search_items) && doneMsg.web_search_items.length > 0) message.web_search_items = doneMsg.web_search_items;
  if (Array.isArray(doneMsg?.response_reasoning_items) && doneMsg.response_reasoning_items.length > 0) {
    message._responsesReasoningItems = doneMsg.response_reasoning_items;
  }
  if (Array.isArray(doneMsg?.response_replay_items) && doneMsg.response_replay_items.length > 0) {
    message._responsesReplayItems = doneMsg.response_replay_items;
  }
  return copyAssistantUsageFields(apiType, model, doneMsg, copyAssistantReasoningFields(doneMsg, message));
}
export function buildAssistantToolCallMessage(apiType, model, textContent, doneMsg) {
  if (normalizeApiType(apiType) === API_TYPES.ANTHROPIC) {
    return copyAssistantUsageFields(apiType, model, doneMsg, copyAnthropicThinkingFields(doneMsg, { role: "assistant", content: doneMsg.content }));
  }

  const message = {
    role: "assistant",
    content: textContent || null,
    tool_calls: doneMsg._openaiToolCalls
  };
  if (doneMsg?.response_id) {
    message._responsesResponseId = doneMsg.response_id;
  }
  if (Array.isArray(doneMsg?.response_content) && doneMsg.response_content.length > 0) {
    message._responsesContent = doneMsg.response_content;
  }
  if (Array.isArray(doneMsg?.citations) && doneMsg.citations.length > 0) message.citations = doneMsg.citations;
  if (Array.isArray(doneMsg?.web_searches) && doneMsg.web_searches.length > 0) message.web_searches = doneMsg.web_searches;
  if (Array.isArray(doneMsg?.web_search_items) && doneMsg.web_search_items.length > 0) message.web_search_items = doneMsg.web_search_items;
  if (Array.isArray(doneMsg?.response_reasoning_items) && doneMsg.response_reasoning_items.length > 0) {
    message._responsesReasoningItems = doneMsg.response_reasoning_items;
  }
  if (Array.isArray(doneMsg?.response_replay_items) && doneMsg.response_replay_items.length > 0) {
    message._responsesReplayItems = doneMsg.response_replay_items;
  }
  return copyAssistantUsageFields(apiType, model, doneMsg, copyAssistantReasoningFields(doneMsg, message));
}

export function copyAssistantUsageFields(apiType, model, source, target) {
  if (source?.usage && typeof source.usage === "object") {
    target.usage = source.usage;
    target._usageApiType = apiType || "";
    target._usageModel = model || "";
  }
  return target;
}

export function copyAnthropicThinkingFields(source, target) {
  for (const field of ["thinking_blocks", "provider_specific_fields"]) {
    const value = source?.[field];
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    target[field] = value;
  }
  return target;
}

export function copyAssistantReasoningFields(source, target) {
  for (const field of ["reasoning_content", "reasoning", "reasoning_details", "thinking"]) {
    const value = source?.[field];
    if (value == null) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    target[field] = value;
  }
  return target;
}
