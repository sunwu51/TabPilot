import {
  API_TYPES,
  getDefaultApiType,
  normalizeApiType,
  normalizeModelContextLimitTokens
} from "./config";

export const DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID = "llm_opencode_zen_big_pickle";
const LEGACY_BUILTIN_LLM_MODEL_IDS = new Set(["llm_opencode_zen_deepseek_v4_flash_free"]);
export const DEFAULT_OPENCODE_ZEN_FREE_LLM_PROFILE = Object.freeze({
  id: DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID,
  name: "OpenCode Zen Big Pickle",
  apiType: API_TYPES.OPENAI_CHAT_COMPLETIONS,
  baseUrl: "https://opencode.ai/zen/v1/chat/completions",
  apiKey: "",
  model: "big-pickle",
  requiresApiKey: false
});
export const DEFAULT_LLM_MODEL_PROFILES = Object.freeze([DEFAULT_OPENCODE_ZEN_FREE_LLM_PROFILE]);
export const DEFAULT_IMAGE_MODEL_PROFILE = "gpt-image-2";
export const DEFAULT_IMAGE_API_PROTOCOL = "generate";
export const IMAGE_CHAT_COMPLETIONS_PROTOCOL = "chat_completions";

export function createModelProfileId(prefix = "model") {
  return `${prefix}_${generateHex()}`;
}

export function createImageModelProfileId(modelName = "") {
  const slug = slugify(modelName);
  const hex = generateHex();
  return slug ? `img_${slug}_${hex}` : `img_${hex}`;
}

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function generateHex() {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : null;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(3);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

export function normalizeImageProfileProtocol(value) {
  return value === IMAGE_CHAT_COMPLETIONS_PROTOCOL ? IMAGE_CHAT_COMPLETIONS_PROTOCOL : DEFAULT_IMAGE_API_PROTOCOL;
}

export function normalizeLlmModelProfiles(llmConfig = {}) {
  const rawProfiles = Array.isArray(llmConfig.llmModels) ? llmConfig.llmModels : [];
  const sourceProfiles = [
    DEFAULT_OPENCODE_ZEN_FREE_LLM_PROFILE,
    ...rawProfiles.filter(item => !isBuiltinLlmModelProfileId(item?.id))
  ];
  const profiles = sourceProfiles
    .map((item, index) => normalizeLlmModelProfile(item, index))
    .filter(Boolean)
    .filter(dedupeProfileById());

  const fallbackProfile = rawProfiles.length > 0
    ? (profiles.find(item => !isBuiltinLlmModelProfileId(item.id)) || profiles[0])
    : profiles[0];
  const activeId = profiles.some(item => item.id === llmConfig.activeLlmModelId)
    ? llmConfig.activeLlmModelId
    : (fallbackProfile?.id || "");
  return { profiles, activeId, activeProfile: profiles.find(item => item.id === activeId) || null };
}

export function normalizeImageModelProfiles(llmConfig = {}) {
  const rawProfiles = Array.isArray(llmConfig.imageModels) ? llmConfig.imageModels : [];
  const profiles = rawProfiles
    .map((item, index) => normalizeImageModelProfile(item, index))
    .filter(Boolean);

  const activeId = profiles.some(item => item.id === llmConfig.activeImageModelId)
    ? llmConfig.activeImageModelId
    : (profiles[0]?.id || "");
  return { profiles, activeId, activeProfile: profiles.find(item => item.id === activeId) || null };
}

export function resolveActiveLlmConfig(llmConfig = {}) {
  const { profiles, activeId, activeProfile } = normalizeLlmModelProfiles(llmConfig);
  const merged = {
    ...llmConfig,
    llmModels: profiles,
    activeLlmModelId: activeId,
    apiType: normalizeApiType(activeProfile?.apiType || getDefaultApiType()),
    baseUrl: activeProfile?.baseUrl ?? "",
    apiKey: activeProfile?.apiKey ?? "",
    model: activeProfile?.model ?? "",
    nativeWebSearch: activeProfile?.nativeWebSearch === true,
    requiresApiKey: activeProfile?.requiresApiKey !== false,
    modelContextLimitTokens: normalizeModelContextLimitTokens(llmConfig.modelContextLimitTokens),
    firstPacketTimeoutSeconds: Math.max(1, Number(llmConfig.firstPacketTimeoutSeconds) || 20),
    supportsImageInput: llmConfig.supportsImageInput === true,
    supportsToolImageInput: llmConfig.supportsImageInput === true && llmConfig.supportsToolImageInput === true,
    reasoningEffort: llmConfig.reasoningEffort || "default",
    omitThinkingFromRequests: llmConfig.omitThinkingFromRequests === true
  };
  return merged;
}

export function resolveActiveImageConfig(llmConfig = {}, imageModelId = "") {
  const { profiles, activeId, activeProfile } = normalizeImageModelProfiles(llmConfig);
  const requestedId = String(imageModelId || "").trim();
  const selectedProfile = requestedId
    ? profiles.find(item => item.id === requestedId)
    : activeProfile;
  if (requestedId && !selectedProfile) {
    return {
      error: `Configured image model not found: ${requestedId}`,
      profiles,
      activeId,
      activeProfile
    };
  }
  const profile = selectedProfile || activeProfile;
  return {
    ...llmConfig,
    imageModels: profiles,
    activeImageModelId: profile?.id || activeId,
    imageBaseUrl: profile?.imageBaseUrl || "",
    imageApiKey: profile?.imageApiKey || "",
    imageApiProtocol: normalizeImageProfileProtocol(profile?.imageApiProtocol),
    imageModel: profile ? (profile.imageModel || DEFAULT_IMAGE_MODEL_PROFILE) : "",
    selectedImageProfile: profile || null
  };
}

export function syncActiveModelFields(llmConfig = {}) {
  const activeLlmConfig = resolveActiveLlmConfig(llmConfig);
  const activeImageConfig = resolveActiveImageConfig(activeLlmConfig);
  return {
    ...activeLlmConfig,
    imageModels: activeImageConfig.imageModels,
    activeImageModelId: activeImageConfig.activeImageModelId,
    imageBaseUrl: activeImageConfig.imageBaseUrl,
    imageApiKey: activeImageConfig.imageApiKey,
    imageApiProtocol: activeImageConfig.imageApiProtocol,
    imageModel: activeImageConfig.imageModel
  };
}

export function normalizeStoredModelConfig(llmConfig = {}) {
  const llmProfiles = normalizeLlmModelProfiles(llmConfig);
  const imageProfiles = normalizeImageModelProfiles(llmConfig);
  return {
    activeLlmModelId: llmProfiles.activeId,
    llmModels: llmProfiles.profiles,
    modelContextLimitTokens: normalizeModelContextLimitTokens(llmConfig.modelContextLimitTokens),
    firstPacketTimeoutSeconds: Math.max(1, Number(llmConfig.firstPacketTimeoutSeconds) || 20),
    supportsImageInput: llmConfig.supportsImageInput === true,
    supportsToolImageInput: llmConfig.supportsImageInput === true && llmConfig.supportsToolImageInput === true,
    reasoningEffort: llmConfig.reasoningEffort || "default",
    omitThinkingFromRequests: llmConfig.omitThinkingFromRequests === true,
    activeImageModelId: imageProfiles.activeId,
    imageModels: imageProfiles.profiles
  };
}

export function isConfiguredImageProfile(profile = {}) {
  return !!String(profile.imageBaseUrl || "").trim() && !!String(profile.imageApiKey || "").trim();
}

function normalizeLlmModelProfile(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const model = String(item.model || "").trim();
  const baseUrl = String(item.baseUrl || "").trim();
  const apiKey = String(item.apiKey || "").trim();
  const apiType = normalizeApiType(item.apiType || getDefaultApiType());
  if (!model && !baseUrl && !apiKey) return null;
  return {
    id: String(item.id || `llm_${index + 1}`).trim() || `llm_${index + 1}`,
    name: String(item.name || model || `模型 ${index + 1}`).trim() || `模型 ${index + 1}`,
    apiType,
    baseUrl,
    apiKey,
    model,
    nativeWebSearch: item.nativeWebSearch === true,
    ...(item.requiresApiKey === false ? { requiresApiKey: false } : {})
  };
}

export function isLlmConfigUsable(config = {}) {
  const activeConfig = Array.isArray(config.llmModels) ? resolveActiveLlmConfig(config) : config;
  const requiresApiKey = activeConfig.requiresApiKey !== false;
  return !!String(activeConfig.baseUrl || "").trim() &&
    !!String(activeConfig.model || "").trim() &&
    (!requiresApiKey || !!String(activeConfig.apiKey || "").trim());
}

export function buildLlmAuthHeaders(config = {}, headerName = "Authorization") {
  const apiKey = String(config?.apiKey || "").trim();
  if (!apiKey) return {};
  if (headerName === "x-api-key") return { "x-api-key": apiKey };
  return { [headerName]: `Bearer ${apiKey}` };
}

export function isBuiltinLlmModelProfileId(id) {
  const normalizedId = String(id || "").trim();
  return normalizedId === DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID || LEGACY_BUILTIN_LLM_MODEL_IDS.has(normalizedId);
}

function dedupeProfileById() {
  const seen = new Set();
  return (profile) => {
    if (seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  };
}

function normalizeImageModelProfile(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const imageModel = String(item.imageModel || DEFAULT_IMAGE_MODEL_PROFILE).trim() || DEFAULT_IMAGE_MODEL_PROFILE;
  const imageBaseUrl = String(item.imageBaseUrl || "").trim();
  const imageApiKey = String(item.imageApiKey || "").trim();
  if (!imageModel && !imageBaseUrl && !imageApiKey) return null;
  return {
    id: String(item.id || `img_${index + 1}`).trim() || `img_${index + 1}`,
    name: String(item.name || imageModel || `图片模型 ${index + 1}`).trim() || `图片模型 ${index + 1}`,
    imageBaseUrl,
    imageApiKey,
    imageApiProtocol: normalizeImageProfileProtocol(item.imageApiProtocol),
    imageModel
  };
}
