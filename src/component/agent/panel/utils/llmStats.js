import { API_TYPES, MODEL_CONTEXT_WARNING_THRESHOLD_RATIO, normalizeApiType, getDefaultApiType, normalizeModelContextLimitTokens } from "../../../../api/llm";

export function buildContextUsage(apiType, model, usage) {
  if (!usage || typeof usage !== "object") return null;
  const tokens = calculateContextTokens(apiType, usage);
  return {
    apiType: normalizeApiType(apiType || getDefaultApiType()),
    model: model || "",
    tokens: Number.isFinite(tokens) ? tokens : null,
    usageStatus: Number.isFinite(tokens) ? "ok" : "unrecognized",
    usage
  };
}

export function getLatestContextUsageFromMessages(messages, fallbackConfig = {}) {
  for (let index = (messages || []).length - 1; index >= 0; index--) {
    const msg = messages[index];
    if (!msg?.usage) continue;
    const usageInfo = buildContextUsage(
      normalizeApiType(msg._usageApiType || fallbackConfig.apiType || getDefaultApiType()),
      msg._usageModel || fallbackConfig.model || "",
      msg.usage
    );
    if (usageInfo) return usageInfo;
  }
  return null;
}

export function calculateContextTokens(apiType, usage) {
  if (!usage || typeof usage !== "object") return null;
  const anthropicFields = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens"
  ];
  const openAiFields = ["prompt_tokens", "completion_tokens"];

  if (normalizeApiType(apiType) === API_TYPES.ANTHROPIC) {
    return firstFiniteNumber(
      sumTokenFields(usage, anthropicFields),
      sumTokenFields(usage, openAiFields),
      getFirstUsageNumber(usage, ["total_tokens", "totalTokens", "total"])
    );
  }
  return firstFiniteNumber(
    sumTokenFields(usage, openAiFields),
    sumTokenFields(usage, anthropicFields),
    getFirstUsageNumber(usage, ["total_tokens", "totalTokens", "total"])
  );
}

export function sumTokenFields(source, fields) {
  let total = 0;
  let hasValue = false;
  for (const field of fields) {
    const value = Number(source?.[field]);
    if (!Number.isFinite(value)) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

export function firstFiniteNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function getFirstUsageNumber(source, fields) {
  for (const field of fields) {
    const value = Number(source?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function formatModelName(model) {
  return String(model || "").trim() || "未配置";
}

export function normalizeReasoningEffort(value) {
  return ["default", "low", "medium", "high", "xhigh"].includes(value) ? value : "default";
}

export function isContextUsageWarning(contextUsage, limitTokens) {
  const tokens = Number(contextUsage?.tokens);
  const normalizedLimit = normalizeModelContextLimitTokens(limitTokens);
  return Number.isFinite(tokens) && tokens >= normalizedLimit * MODEL_CONTEXT_WARNING_THRESHOLD_RATIO;
}

export function formatContextLimitK(limitTokens) {
  const normalizedLimit = normalizeModelContextLimitTokens(limitTokens);
  if (normalizedLimit >= 1000000) return `${normalizedLimit / 1000000}M`;
  return `${Math.round(normalizedLimit / 1000)}K`;
}

export function formatContextUsageK(contextUsage) {
  const tokens = Number(contextUsage?.tokens);
  if (contextUsage?.usageStatus === "unrecognized") return "未识别";
  if (!Number.isFinite(tokens)) return "未返回";
  const value = tokens / 1000;
  if (value >= 100) return `${Math.round(value)}K`;
  if (value >= 10) return `${value.toFixed(1)}K`;
  return `${value.toFixed(2)}K`;
}

export const REQUEST_BODY_SIZE_DISPLAY_BYTES = 1024 * 1024;
export const REQUEST_BODY_SIZE_WARNING_BYTES = 5 * 1024 * 1024;

export function normalizeRequestBodySize(size) {
  const bytes = Number(size?.bytes ?? size);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return {
    bytes,
    apiType: size?.apiType || "",
    model: size?.model || ""
  };
}

export function shouldShowRequestBodySize(size) {
  const bytes = Number(size?.bytes);
  return Number.isFinite(bytes) && bytes >= REQUEST_BODY_SIZE_DISPLAY_BYTES;
}

export function isRequestBodySizeWarning(size) {
  const bytes = Number(size?.bytes);
  return Number.isFinite(bytes) && bytes >= REQUEST_BODY_SIZE_WARNING_BYTES;
}

export function formatRequestBodySizeM(size) {
  const bytes = Number(size?.bytes);
  if (!Number.isFinite(bytes)) return "未计算";
  const value = bytes / REQUEST_BODY_SIZE_DISPLAY_BYTES;
  if (value >= 10) return `${Math.round(value)}M`;
  return `${value.toFixed(1)}M`;
}

