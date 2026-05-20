import { API_TYPES, normalizeApiType } from "./config";

const OPENAI_COMPLETIONS_PATH = "/v1/chat/completions";
const OPENAI_RESPONSES_PATH = "/v1/responses";
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

export function getDefaultLlmEndpointPath(apiType) {
  const normalizedApiType = normalizeApiType(apiType);
  if (normalizedApiType === API_TYPES.ANTHROPIC) return ANTHROPIC_MESSAGES_PATH;
  if (normalizedApiType === API_TYPES.OPENAI_RESPONSES) return OPENAI_RESPONSES_PATH;
  return OPENAI_COMPLETIONS_PATH;
}

export function resolveLlmRequestUrl(apiType, baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";

  const defaultPath = getDefaultLlmEndpointPath(apiType);
  const explicitPath = detectExplicitPath(raw);
  if (explicitPath) {
    return raw;
  }

  return `${raw.replace(/\/+$/, "")}${defaultPath}`;
}

function detectExplicitPath(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname && parsed.pathname !== "/" && !parsed.pathname.endsWith("/");
  } catch {
    const withoutQuery = rawUrl.split(/[?#]/, 1)[0];
    const normalized = withoutQuery.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]+/, "");
    if (!normalized) return false;
    return normalized !== "/" && !normalized.endsWith("/");
  }
}
