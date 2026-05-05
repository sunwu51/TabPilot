export const API_TYPES = {
  OPENAI_CHAT_COMPLETIONS: "openai-chat-completions",
  OPENAI_RESPONSES: "openai-responses",
  ANTHROPIC: "anthropic"
};

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
