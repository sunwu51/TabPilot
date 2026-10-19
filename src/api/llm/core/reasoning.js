export const REASONING_EFFORT_PRESETS = ["low", "medium", "high", "xhigh", "max"];
const MAX_CUSTOM_REASONING_EFFORT_LENGTH = 64;

// Stored form: "default", a preset, or a custom provider-specific value passed through verbatim.
export function normalizeStoredReasoningEffort(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_CUSTOM_REASONING_EFFORT_LENGTH);
  return text || "default";
}

export function isCustomReasoningEffort(value) {
  const effort = normalizeStoredReasoningEffort(value);
  return effort !== "default" && !REASONING_EFFORT_PRESETS.includes(effort);
}

// Request form: the effort to send, or "" to omit reasoning fields.
export function normalizeReasoningEffort(value) {
  const effort = normalizeStoredReasoningEffort(value);
  return effort === "default" ? "" : effort;
}

export function buildOpenAIChatReasoningFields(config = {}) {
  if (config.supportsReasoning === false) return {};
  const effort = normalizeReasoningEffort(config.reasoningEffort);
  return effort ? { reasoning_effort: effort, reasoning: { effort } } : {};
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
