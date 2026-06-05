import {
  DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
  getDefaultApiType,
  normalizeApiType,
  normalizeModelContextLimitTokens
} from "./config";

export const DEFAULT_IMAGE_MODEL_PROFILE = "gpt-image-2";
export const DEFAULT_IMAGE_API_PROTOCOL = "generate";
export const IMAGE_CHAT_COMPLETIONS_PROTOCOL = "chat_completions";

export function createModelProfileId(prefix = "model") {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : null;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(3);
    cryptoObj.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `${prefix}_${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
}

export function normalizeImageProfileProtocol(value) {
  return value === IMAGE_CHAT_COMPLETIONS_PROTOCOL ? IMAGE_CHAT_COMPLETIONS_PROTOCOL : DEFAULT_IMAGE_API_PROTOCOL;
}

export function normalizeLlmModelProfiles(llmConfig = {}) {
  const rawProfiles = Array.isArray(llmConfig.llmModels) ? llmConfig.llmModels : [];
  const profiles = rawProfiles
    .map((item, index) => normalizeLlmModelProfile(item, index))
    .filter(Boolean);

  if (profiles.length === 0 && hasLegacyLlmModel(llmConfig)) {
    profiles.push(normalizeLlmModelProfile({
      id: "llm_legacy",
      name: llmConfig.model || "默认模型",
      apiType: llmConfig.apiType,
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model
    }, 0));
  }

  const activeId = profiles.some(item => item.id === llmConfig.activeLlmModelId)
    ? llmConfig.activeLlmModelId
    : (profiles[0]?.id || "");
  return { profiles, activeId, activeProfile: profiles.find(item => item.id === activeId) || null };
}

export function normalizeImageModelProfiles(llmConfig = {}) {
  const rawProfiles = Array.isArray(llmConfig.imageModels) ? llmConfig.imageModels : [];
  const profiles = rawProfiles
    .map((item, index) => normalizeImageModelProfile(item, index))
    .filter(Boolean);

  if (profiles.length === 0 && hasLegacyImageModel(llmConfig)) {
    profiles.push(normalizeImageModelProfile({
      id: "img_legacy",
      name: llmConfig.imageModel || DEFAULT_IMAGE_MODEL_PROFILE,
      imageBaseUrl: llmConfig.imageBaseUrl,
      imageApiKey: llmConfig.imageApiKey,
      imageApiProtocol: llmConfig.imageApiProtocol,
      imageModel: llmConfig.imageModel
    }, 0));
  }

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
    apiType: normalizeApiType(activeProfile?.apiType || llmConfig.apiType || getDefaultApiType()),
    baseUrl: activeProfile?.baseUrl ?? llmConfig.baseUrl ?? "",
    apiKey: activeProfile?.apiKey ?? llmConfig.apiKey ?? "",
    model: activeProfile?.model ?? llmConfig.model ?? "",
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
    imageBaseUrl: profile?.imageBaseUrl ?? llmConfig.imageBaseUrl ?? "",
    imageApiKey: profile?.imageApiKey ?? llmConfig.imageApiKey ?? "",
    imageApiProtocol: normalizeImageProfileProtocol(profile?.imageApiProtocol || llmConfig.imageApiProtocol),
    imageModel: profile?.imageModel || llmConfig.imageModel || DEFAULT_IMAGE_MODEL_PROFILE,
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
    model
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

function hasLegacyLlmModel(llmConfig) {
  return !!String(llmConfig?.baseUrl || llmConfig?.apiKey || llmConfig?.model || "").trim();
}

function hasLegacyImageModel(llmConfig) {
  return !!String(llmConfig?.imageBaseUrl || llmConfig?.imageApiKey || llmConfig?.imageModel || "").trim();
}
