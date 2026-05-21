export function buildPlainApiMessage(msg, options = {}) {
  if (!msg || typeof msg !== "object") return msg;

  const apiMessage = { ...msg };
  for (const field of [
    "sentAt",
    "durationMs",
    "displayImageUrl",
    "displayImages",
    "displayImageMediaType",
    "displayImageOmitFromRequests",
    "_usageApiType",
    "_usageModel",
    "displayContent",
    "injectedUserContext",
    "imageRefs",
    "imageEditMeta"
  ]) {
    delete apiMessage[field];
  }
  if (shouldOmitThinkingFromRequests(options)) {
    for (const field of [
      "thinking_blocks",
      "provider_specific_fields",
      "reasoning_content",
      "reasoning",
      "reasoning_details",
      "thinking",
      "_responsesReasoningItems"
    ]) {
      delete apiMessage[field];
    }
  }
  return apiMessage;
}

export function shouldOmitThinkingFromRequests(options = {}) {
  return options.omitThinkingFromRequests === true;
}
