/* global chrome */
import { normalizeStoredModelConfig } from "../llm/core/modelProfiles";
import { normalizeSubagentTemplates, SUBAGENT_TEMPLATES_STORAGE_KEY } from "../agent/subagentTemplates";
import {
  ensureSettingsMigrated,
  migrateModelProfilesV2,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY
} from "./migrations";

export const SETTINGS_BACKUP_VERSION = 1;

export const SETTINGS_BACKUP_KEYS = [
  "llmConfig",
  "mcpToolTimeoutSeconds",
  "reuse",
  "extractTextLimit",
  "betaFeaturesEnabled",
  "hideCopyButton",
  "dangerousToolSkipApproval",
  "postdogToolsEnabled",
  SUBAGENT_TEMPLATES_STORAGE_KEY,
];

const LLM_CONFIG_KEYS = [
  "apiType",
  "baseUrl",
  "apiKey",
  "model",
  "activeLlmModelId",
  "llmModels",
  "keywordSummaryUseCustomModel",
  "keywordSummaryModelId",
  "modelContextLimitTokens",
  "firstPacketTimeoutSeconds",
  "supportsImageInput",
  "supportsToolImageInput",
  "reasoningEffort",
  "omitThinkingFromRequests",
  "imageBaseUrl",
  "imageApiKey",
  "imageApiProtocol",
  "imageModel",
  "activeImageModelId",
  "imageModels"
];

export async function exportSettingsBackup() {
  await ensureSettingsMigrated();
  const values = await chrome.storage.local.get(SETTINGS_BACKUP_KEYS);
  return {
    format: "tab-manager-settings",
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: pickPresentKeys(values, SETTINGS_BACKUP_KEYS)
  };
}

export function downloadSettingsBackup(backup) {
  const json = `${JSON.stringify(backup, null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `tab-manager-settings-${timestamp}.json`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

export async function importSettingsBackupFromText(text) {
  const parsed = JSON.parse(text);
  const rawSettings = parsed?.settings && typeof parsed.settings === "object"
    ? parsed.settings
    : parsed;
  const patch = normalizeSettingsPatch(rawSettings);
  if (Object.keys(patch).length === 0) {
    return { updatedKeys: [] };
  }
  if (patch.llmConfig) {
    await ensureSettingsMigrated();
    const { llmConfig = {} } = await chrome.storage.local.get({ llmConfig: {} });
    patch.llmConfig = normalizeStoredModelConfig({
      ...(llmConfig && typeof llmConfig === "object" && !Array.isArray(llmConfig) ? llmConfig : {}),
      ...patch.llmConfig
    });
    patch[SETTINGS_SCHEMA_VERSION_KEY] = SETTINGS_SCHEMA_VERSION;
  }
  await chrome.storage.local.set(patch);
  return { updatedKeys: Object.keys(patch) };
}

function normalizeSettingsPatch(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(source, "llmConfig")) {
    const llmConfig = normalizeLlmConfigPatch(source.llmConfig);
    if (Object.keys(llmConfig).length > 0) {
      patch.llmConfig = llmConfig;
    }
  }

  addNumberPatch(patch, source, "mcpToolTimeoutSeconds", { min: 1, integer: true });
  addBooleanPatch(patch, source, "reuse");
  addNumberPatch(patch, source, "extractTextLimit", { min: 1, integer: true });
  addBooleanPatch(patch, source, "betaFeaturesEnabled");
  addBooleanPatch(patch, source, "hideCopyButton");
  addBooleanPatch(patch, source, "dangerousToolSkipApproval");
  addBooleanPatch(patch, source, "postdogToolsEnabled");
  if (Object.prototype.hasOwnProperty.call(source, SUBAGENT_TEMPLATES_STORAGE_KEY)) {
    patch[SUBAGENT_TEMPLATES_STORAGE_KEY] = normalizeSubagentTemplates(source[SUBAGENT_TEMPLATES_STORAGE_KEY]);
  }

  return patch;
}

function normalizeLlmConfigPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = pickPresentKeys(value, LLM_CONFIG_KEYS);
  const migrated = migrateModelProfilesV2(source);
  const patch = {};

  addPresentPatch(patch, source, migrated, "activeLlmModelId");
  addPresentPatch(patch, source, migrated, "llmModels", { legacyKeys: ["baseUrl", "apiKey", "model"] });
  addPresentPatch(patch, source, migrated, "activeImageModelId");
  addPresentPatch(patch, source, migrated, "imageModels", { legacyKeys: ["imageBaseUrl", "imageApiKey", "imageModel"] });
  if (Object.prototype.hasOwnProperty.call(source, "modelContextLimitTokens")) {
    patch.modelContextLimitTokens = migrated.modelContextLimitTokens;
  }
  addNumberPatch(patch, source, "firstPacketTimeoutSeconds", { min: 1, integer: true });
  addBooleanPatch(patch, source, "supportsImageInput");
  addBooleanPatch(patch, source, "supportsToolImageInput");
  if (Object.prototype.hasOwnProperty.call(source, "reasoningEffort")) {
    patch.reasoningEffort = normalizeReasoningEffort(source.reasoningEffort);
  }
  addBooleanPatch(patch, source, "omitThinkingFromRequests");
  addBooleanPatch(patch, source, "keywordSummaryUseCustomModel");
  if (Object.prototype.hasOwnProperty.call(source, "keywordSummaryModelId")) {
    patch.keywordSummaryModelId = String(source.keywordSummaryModelId || "").trim();
  }

  return patch;
}

function pickPresentKeys(source, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

function addPresentPatch(patch, source, normalized, key, { legacyKeys = [] } = {}) {
  const hasNewKey = Object.prototype.hasOwnProperty.call(source, key);
  const hasLegacyKey = legacyKeys.some(item => Object.prototype.hasOwnProperty.call(source, item));
  if (!hasNewKey && !hasLegacyKey) return;
  patch[key] = normalized[key];
}

function addBooleanPatch(patch, source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return;
  patch[key] = source[key] === true;
}

function addNumberPatch(patch, source, key, { min = -Infinity, integer = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return;
  const value = Number(source[key]);
  if (!Number.isFinite(value)) return;
  const normalized = integer ? Math.trunc(value) : value;
  patch[key] = Math.max(min, normalized);
}

function normalizeReasoningEffort(value) {
  return ["default", "low", "medium", "high", "xhigh"].includes(value) ? value : "default";
}
