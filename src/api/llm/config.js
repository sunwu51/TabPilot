export const API_TYPES = {
  OPENAI_CHAT_COMPLETIONS: "openai-chat-completions",
  OPENAI_RESPONSES: "openai-responses",
  ANTHROPIC: "anthropic"
};

export const MODEL_CONTEXT_LIMIT_OPTIONS = [
  { label: "200K", value: 200000 },
  { label: "400K", value: 400000 },
  { label: "1M", value: 1000000 }
];

export const DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS = MODEL_CONTEXT_LIMIT_OPTIONS[0].value;
export const MODEL_CONTEXT_WARNING_THRESHOLD_RATIO = 0.9;

export function normalizeApiType(apiType) {
  const raw = String(apiType || "").trim();
  if (raw === "openai") return API_TYPES.OPENAI_CHAT_COMPLETIONS;
  if (raw === API_TYPES.OPENAI_CHAT_COMPLETIONS) return API_TYPES.OPENAI_CHAT_COMPLETIONS;
  if (raw === API_TYPES.OPENAI_RESPONSES) return API_TYPES.OPENAI_RESPONSES;
  if (raw === API_TYPES.ANTHROPIC) return API_TYPES.ANTHROPIC;
  return API_TYPES.OPENAI_CHAT_COMPLETIONS;
}

export function getDefaultApiType() {
  return API_TYPES.OPENAI_CHAT_COMPLETIONS;
}

export function normalizeModelContextLimitTokens(value) {
  const numericValue = Number(value);
  const matched = MODEL_CONTEXT_LIMIT_OPTIONS.find((item) => item.value === numericValue);
  return matched ? matched.value : DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS;
}
