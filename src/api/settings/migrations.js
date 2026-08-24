/* global chrome */
import {
  DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
  getDefaultApiType,
  normalizeApiType,
  normalizeModelContextLimitTokens
} from "../llm/core/config";
import {
  normalizeImageModelProfiles,
  normalizeImageProfileProtocol,
  normalizeLlmModelProfiles,
  createImageModelProfileId
} from "../llm/core/modelProfiles";

export const SETTINGS_SCHEMA_VERSION = 2;
export const SETTINGS_SCHEMA_VERSION_KEY = "settingsSchemaVersion";

const LEGACY_LLM_CONFIG_KEYS = [
  "apiType",
  "baseUrl",
  "apiKey",
  "model",
  "imageBaseUrl",
  "imageApiKey",
  "imageApiProtocol",
  "imageModel"
];

/**
 * One-time storage migration entrypoint.
 *
 * v2 moves old singleton model fields into llmModels/imageModels and removes the
 * old keys from llmConfig. After Chrome Web Store telemetry shows no users are
 * upgrading from versions older than this schema, delete:
 * - SETTINGS_SCHEMA_VERSION < 2 handling in ensureSettingsMigrated()
 * - migrateModelProfilesV2()
 * - LEGACY_LLM_CONFIG_KEYS and legacy profile builders in this file
 * Keep SETTINGS_SCHEMA_VERSION_KEY for future storage migrations.
 */
export async function ensureSettingsMigrated() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) {
    return { migrated: false, version: SETTINGS_SCHEMA_VERSION };
  }
  const values = await chrome.storage.local.get({
    [SETTINGS_SCHEMA_VERSION_KEY]: 0,
    llmConfig: {}
  });
  const currentVersion = Number(values[SETTINGS_SCHEMA_VERSION_KEY]) || 0;
  if (currentVersion >= SETTINGS_SCHEMA_VERSION) {
    return { migrated: false, version: currentVersion };
  }

  const patch = {
    [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION
  };

  if (currentVersion < 2) {
    patch.llmConfig = migrateModelProfilesV2(values.llmConfig || {});
  }

  await chrome.storage.local.set(patch);
  return { migrated: true, version: SETTINGS_SCHEMA_VERSION };
}

export function migrateModelProfilesV2(llmConfig = {}) {
  const source = llmConfig && typeof llmConfig === "object" && !Array.isArray(llmConfig)
    ? llmConfig
    : {};
  const llmProfiles = normalizeLlmModelProfiles({
    ...source,
    llmModels: Object.prototype.hasOwnProperty.call(source, "llmModels")
      ? source.llmModels
      : buildLegacyLlmProfiles(source)
  });
  const imageProfiles = normalizeImageModelProfiles({
    ...source,
    imageModels: Object.prototype.hasOwnProperty.call(source, "imageModels")
      ? source.imageModels
      : buildLegacyImageProfiles(source)
  });

  return stripLegacyLlmConfigKeys({
    activeLlmModelId: llmProfiles.activeId,
    llmModels: llmProfiles.profiles,
    modelContextLimitTokens: normalizeModelContextLimitTokens(source.modelContextLimitTokens || DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS),
    firstPacketTimeoutSeconds: Math.max(1, Number(source.firstPacketTimeoutSeconds) || 20),
    supportsImageInput: source.supportsImageInput === true,
    supportsToolImageInput: source.supportsImageInput === true && source.supportsToolImageInput === true,
    reasoningEffort: normalizeReasoningEffort(source.reasoningEffort),
    omitThinkingFromRequests: source.omitThinkingFromRequests === true,
    keywordSummaryUseCustomModel: source.keywordSummaryUseCustomModel === true,
    keywordSummaryModelId: String(source.keywordSummaryModelId || ""),
    activeImageModelId: imageProfiles.activeId,
    imageModels: imageProfiles.profiles
  });
}

export function stripLegacyLlmConfigKeys(llmConfig = {}) {
  const next = { ...llmConfig };
  for (const key of LEGACY_LLM_CONFIG_KEYS) {
    delete next[key];
  }
  return next;
}

function buildLegacyLlmProfiles(source) {
  if (!hasAnyLegacyLlmModel(source)) return [];
  const model = String(source.model || "").trim();
  return [
    {
      id: "llm_legacy",
      name: model || "默认模型",
      apiType: normalizeApiType(source.apiType || getDefaultApiType()),
      baseUrl: String(source.baseUrl || "").trim(),
      apiKey: String(source.apiKey || "").trim(),
      model
    }
  ];
}

function buildLegacyImageProfiles(source) {
  if (!hasAnyLegacyImageModel(source)) return [];
  const imageModel = String(source.imageModel || "gpt-image-2").trim() || "gpt-image-2";
  return [
    {
      id: createImageModelProfileId(imageModel),
      name: imageModel,
      imageBaseUrl: String(source.imageBaseUrl || "").trim(),
      imageApiKey: String(source.imageApiKey || "").trim(),
      imageApiProtocol: normalizeImageProfileProtocol(source.imageApiProtocol),
      imageModel
    }
  ];
}

function hasAnyLegacyLlmModel(source) {
  return !!String(source?.baseUrl || source?.apiKey || source?.model || "").trim();
}

function hasAnyLegacyImageModel(source) {
  return !!String(source?.imageBaseUrl || source?.imageApiKey || source?.imageModel || "").trim();
}

function normalizeReasoningEffort(value) {
  return ["default", "low", "medium", "high", "xhigh"].includes(value) ? value : "default";
}
