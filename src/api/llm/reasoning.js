const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export function normalizeReasoningEffort(value) {
  return SUPPORTED_REASONING_EFFORTS.has(value) ? value : "";
}

export function buildOpenAIChatReasoningFields(config = {}) {
  const effort = normalizeReasoningEffort(config.reasoningEffort);
  return effort ? { reasoning_effort: effort } : {};
}

export function buildOpenAIResponsesReasoningFields(config = {}) {
  const effort = normalizeReasoningEffort(config.reasoningEffort);
  return effort ? { reasoning: { effort } } : {};
}

export function buildAnthropicReasoningFields(config = {}) {
  const effort = normalizeReasoningEffort(config.reasoningEffort);
  if (!effort) return {};
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort }
  };
}
