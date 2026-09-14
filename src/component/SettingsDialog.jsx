/* global chrome */
import { Button, Checkbox, Dialog, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import SubscriptionUsage from "./SubscriptionUsage";
import MemoryManager from "./MemoryManager";
import toast from "react-hot-toast";
import { resolveLlmRequestUrl } from "../api/llm/core/endpoint";
import {
  API_TYPES,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
  IMAGE_API_PROTOCOLS,
  captureFullPageScreenshotToTab,
  createModelProfileId,
  createImageModelProfileId,
  getDefaultApiType,
  normalizeApiType,
  normalizeImageModelProfiles,
  normalizeImageApiProtocol,
  normalizeLlmModelProfiles,
  normalizeStoredModelConfig,
  BUILTIN_TOOL_GROUPS,
  openHelloWorldPlayground,
  resolveImageApiRequestUrl
} from "../api/llm";
import {
  downloadSettingsBackup,
  exportSettingsBackup,
  importSettingsBackupFromText
} from "../api/settings/backup";
import { ensureSettingsMigrated } from "../api/settings/migrations";
import { SUBAGENT_TEMPLATES_STORAGE_KEY, normalizeSubagentTemplates } from "../api/agent/subagentTemplates";
import { useI18n, useLocalizedDom } from "../i18n";
import {
  SUPABASE_DEFAULT_CONFIG,
  hasUsableSupabaseConfig,
  loadSupabaseConfig,
  saveSupabaseConfig
} from "../api/supabase/config";
import { overwriteSupabaseSettingsFromLocal, restoreSettingsFromSupabase, syncSessionsWithSupabase } from "../api/supabase/backup";

import { clearReuseDomainPolicies, getReuseDomainPolicies } from "../api/browser/tabReuse";
import {
  DEFAULT_WS_BRIDGE_STATUS,
  formatWsBridgeStatusTime,
  getWsBridgeStateMeta,
  WS_BRIDGE_STATUS_STORAGE_KEY
} from "../api/bridge/wsBridgeStatus";

const DEFAULT_SETTINGS = {
  llmConfig: {
    activeLlmModelId: "",
    llmModels: [],
    keywordSummaryUseCustomModel: false,
    keywordSummaryModelId: "",
    modelContextLimitTokens: DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
    firstPacketTimeoutSeconds: 20,
    supportsImageInput: false,
    supportsToolImageInput: false,
    reasoningEffort: "default",
    omitThinkingFromRequests: false,
    activeImageModelId: "",
    imageModels: []
  },
  mcpToolTimeoutSeconds: 60,
  reuse: false,
  extractTextLimit: 8000,
  betaFeaturesEnabled: false,
  bridgeEnabled: false,
  wsServerUrl: "",
  hideCopyButton: false,
  ttsVoiceName: "",
  dangerousToolSkipApproval: false,
      postdogToolsEnabled: false,
      subagentTemplates: [],
      mcpServers: []
};

/**
 * Settings dialog for LLM API configuration, tab reuse, and auto-suspend.
 * Draft values are only persisted when the user confirms.
 */
export default function SettingsDialog() {
  const { t } = useI18n();
  return (
    <Dialog trigger={<Button className="!min-w-16 !w-auto !px-3">{t("settings")}</Button>}>
      <SettingsDialogBody />
    </Dialog>
  );
}

const ADVANCED_USAGE_URL = "https://my.feishu.cn/wiki/EyDcwiBaliWlDNkRVv0cOAVHnUd?from=from_copylink";
const DEFAULT_LLM_MODEL_DRAFT = {
  apiType: getDefaultApiType(),
  baseUrl: "",
  apiKey: "",
  model: ""
};
const DEFAULT_IMAGE_MODEL_DRAFT = {
  imageBaseUrl: "",
  imageApiKey: "",
  imageApiProtocol: IMAGE_API_PROTOCOLS.GENERATE,
  imageModel: ""
};
const OPENAI_IMAGE_GENERATION_MODELS = [
  { label: "Auto", value: "" },
  { label: "GPT Image 2.5 Sunburst", value: "gpt-image-2.5-sunburst" },
  { label: "GPT Image 2.5 Flare", value: "gpt-image-2.5-flare" },
  { label: "GPT Image 2", value: "gpt-image-2" }
];

function dedupeSubscriptionProfiles(profiles) {
  const seen = new Set();
  return profiles.filter((profile) => {
    if (profile.apiType !== API_TYPES.OPENAI_SUBSCRIPTION) return true;
    const key = `${profile.credentialId || profile.id}\n${String(profile.model || "").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function SettingsDialogBody() {
  const { locale, setLocale, t } = useI18n();
  const [apiType, setApiType] = useState(DEFAULT_LLM_MODEL_DRAFT.apiType);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LLM_MODEL_DRAFT.baseUrl);
  const [apiKey, setApiKey] = useState(DEFAULT_LLM_MODEL_DRAFT.apiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showImageApiKey, setShowImageApiKey] = useState(false);
  const [model, setModel] = useState(DEFAULT_LLM_MODEL_DRAFT.model);
  const [nativeWebSearch, setNativeWebSearch] = useState(false);
  const [llmModels, setLlmModels] = useState(DEFAULT_SETTINGS.llmConfig.llmModels);
  const [activeLlmModelId, setActiveLlmModelId] = useState(DEFAULT_SETTINGS.llmConfig.activeLlmModelId);
  const [keywordSummaryUseCustomModel, setKeywordSummaryUseCustomModel] = useState(DEFAULT_SETTINGS.llmConfig.keywordSummaryUseCustomModel);
  const [keywordSummaryModelId, setKeywordSummaryModelId] = useState(DEFAULT_SETTINGS.llmConfig.keywordSummaryModelId);
  const [llmModelFormOpen, setLlmModelFormOpen] = useState(false);
  const [editingLlmModelId, setEditingLlmModelId] = useState("");
  const [openAiLoginPending, setOpenAiLoginPending] = useState(false);
  const [subscriptionAvailableModels, setSubscriptionAvailableModels] = useState([]);
  const [selectedSubscriptionModels, setSelectedSubscriptionModels] = useState([]);
  const [subscriptionModelsLoading, setSubscriptionModelsLoading] = useState(false);
  const [subscriptionModelManagerOpen, setSubscriptionModelManagerOpen] = useState(false);
  const [firstPacketTimeoutSeconds, setFirstPacketTimeoutSeconds] = useState(DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds);
  const [supportsImageInput, setSupportsImageInput] = useState(DEFAULT_SETTINGS.llmConfig.supportsImageInput);
  const [supportsToolImageInput, setSupportsToolImageInput] = useState(DEFAULT_SETTINGS.llmConfig.supportsToolImageInput);
  const [reasoningEffort, setReasoningEffort] = useState(DEFAULT_SETTINGS.llmConfig.reasoningEffort);
  const [omitThinkingFromRequests, setOmitThinkingFromRequests] = useState(DEFAULT_SETTINGS.llmConfig.omitThinkingFromRequests);
  const [imageBaseUrl, setImageBaseUrl] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageBaseUrl);
  const [imageApiKey, setImageApiKey] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageApiKey);
  const [imageApiProtocol, setImageApiProtocol] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageModel);
  const [imageSourceLlmModelId, setImageSourceLlmModelId] = useState("");
  const [imageGenerationModel, setImageGenerationModel] = useState("");
  const [imageModels, setImageModels] = useState(DEFAULT_SETTINGS.llmConfig.imageModels);
  const [activeImageModelId, setActiveImageModelId] = useState(DEFAULT_SETTINGS.llmConfig.activeImageModelId);
  const [imageModelFormOpen, setImageModelFormOpen] = useState(false);
  const [editingImageModelId, setEditingImageModelId] = useState("");
  const [mcpToolTimeoutSeconds, setMcpToolTimeoutSeconds] = useState(DEFAULT_SETTINGS.mcpToolTimeoutSeconds);
  const [reuse, setReuse] = useState(DEFAULT_SETTINGS.reuse);
  const [extractTextLimit, setExtractTextLimit] = useState(DEFAULT_SETTINGS.extractTextLimit);
  const [betaFeaturesEnabled, setBetaFeaturesEnabled] = useState(DEFAULT_SETTINGS.betaFeaturesEnabled);
  const [bridgeEnabled, setBridgeEnabled] = useState(DEFAULT_SETTINGS.bridgeEnabled);
  const [wsServerUrl, setWsServerUrl] = useState(DEFAULT_SETTINGS.wsServerUrl);
  const [hideCopyButton, setHideCopyButton] = useState(DEFAULT_SETTINGS.hideCopyButton);
  const [ttsVoiceName, setTtsVoiceName] = useState(DEFAULT_SETTINGS.ttsVoiceName);
  const [ttsVoices, setTtsVoices] = useState([]);
  const [dangerousToolSkipApproval, setDangerousToolSkipApproval] = useState(DEFAULT_SETTINGS.dangerousToolSkipApproval);
  const [postdogToolsEnabled, setPostdogToolsEnabled] = useState(DEFAULT_SETTINGS.postdogToolsEnabled);
  const [subagentTemplates, setSubagentTemplates] = useState([]);
  const [subagentTemplateFormOpen, setSubagentTemplateFormOpen] = useState(false);
  const [editingSubagentTemplateId, setEditingSubagentTemplateId] = useState("");
  const [subagentTemplateDraft, setSubagentTemplateDraft] = useState(createEmptySubagentTemplate());
  const [mcpServerOptions, setMcpServerOptions] = useState([]);
  const [wsBridgeStatus, setWsBridgeStatus] = useState(DEFAULT_WS_BRIDGE_STATUS);
  const [reusePolicyCount, setReusePolicyCount] = useState(0);
  const [supabaseUrl, setSupabaseUrl] = useState(SUPABASE_DEFAULT_CONFIG.url);
  const [supabaseKey, setSupabaseKey] = useState(SUPABASE_DEFAULT_CONFIG.key);
  const [supabaseBucket, setSupabaseBucket] = useState(SUPABASE_DEFAULT_CONFIG.bucket);
  const [supabaseBasePath, setSupabaseBasePath] = useState(SUPABASE_DEFAULT_CONFIG.basePath);
  const [showSupabaseKey, setShowSupabaseKey] = useState(false);
  const [supabaseRunning, setSupabaseRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [llmFormKey, setLlmFormKey] = useState(0);
  const [imageFormKey, setImageFormKey] = useState(0);
  const rootRef = useRef(null);
  const localizedRootRef = useLocalizedDom();
  const settingsImportInputRef = useRef(null);
  const extractTextLimitOptions = [
    { label: "8k", value: 8000 },
    { label: "16k", value: 16000 },
    { label: "32k", value: 32000 },
    { label: "128k", value: 128000 }
  ];
  const resolvedApiUrl = resolveLlmRequestUrl(apiType, baseUrl);
  const resolvedImageGenUrl = resolveImageApiRequestUrl(imageBaseUrl, "generations");
  const resolvedImageEditUrl = resolveImageApiRequestUrl(imageBaseUrl, "edits");
  const resolvedImageChatUrl = resolveImageApiRequestUrl(imageBaseUrl, "chat_completions");
  const imageProtocolOptions = [
    { label: "Generate / Edit API", value: IMAGE_API_PROTOCOLS.GENERATE },
    { label: "Chat Completions", value: IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS },
    { label: "OpenAI Built-in Image Gen", value: IMAGE_API_PROTOCOLS.OPENAI_BUILTIN }
  ];
  const builtinImageHostModels = llmModels.filter(item => [API_TYPES.OPENAI_RESPONSES, API_TYPES.OPENAI_SUBSCRIPTION].includes(item.apiType));
  const ttsVoiceOptions = buildTtsVoiceOptions(ttsVoices);

  useEffect(() => {
    void loadDraft();
  }, []);

  useEffect(() => {
    const handleMessage = async (message) => {
      if (message?.type !== "openai_subscription_oauth_completed") return;
      setOpenAiLoginPending(false);
      if (message.success === false) {
        toast.error(`OpenAI Subscription 登录失败: ${message.error || "未知错误"}`);
        return;
      }
      await loadDraft();
      setApiType(API_TYPES.OPENAI_SUBSCRIPTION);
      setEditingLlmModelId(message.profileId);
      setModel(message.model || "");
      setNativeWebSearch(true);
      setLlmModelFormOpen(true);
      setSubscriptionAvailableModels(message.availableModels || []);
      setSelectedSubscriptionModels((message.availableModels || []).map(item => item.id));
      setSubscriptionModelManagerOpen(true);
      toast.success("OpenAI Subscription 登录成功");
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  useEffect(() => {
    const speech = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!speech) return undefined;

    const loadVoices = () => {
      setTtsVoices(speech.getVoices());
    };

    loadVoices();
    if (typeof speech.addEventListener === "function") {
      speech.addEventListener("voiceschanged", loadVoices);
      return () => speech.removeEventListener("voiceschanged", loadVoices);
    }
    const previous = speech.onvoiceschanged;
    speech.onvoiceschanged = loadVoices;
    return () => {
      if (speech.onvoiceschanged === loadVoices) {
        speech.onvoiceschanged = previous || null;
      }
    };
  }, []);

  useEffect(() => {
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[WS_BRIDGE_STATUS_STORAGE_KEY]) {
        setWsBridgeStatus({
          ...DEFAULT_WS_BRIDGE_STATUS,
          ...(changes[WS_BRIDGE_STATUS_STORAGE_KEY].newValue || {})
        });
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  async function loadDraft() {
    setLoading(true);
    try {
      await ensureSettingsMigrated();
      const res = await chrome.storage.local.get({
        ...DEFAULT_SETTINGS,
        [WS_BRIDGE_STATUS_STORAGE_KEY]: DEFAULT_WS_BRIDGE_STATUS
      });
      const rawLlmConfig = res.llmConfig || {};
      const nextLlmConfig = { ...DEFAULT_SETTINGS.llmConfig, ...rawLlmConfig };
      const normalizedLlmProfiles = normalizeLlmModelProfiles(rawLlmConfig);
      const normalizedImageProfiles = normalizeImageModelProfiles(rawLlmConfig);
      setLlmModels(normalizedLlmProfiles.profiles);
      setActiveLlmModelId(normalizedLlmProfiles.activeId);
      setKeywordSummaryUseCustomModel(nextLlmConfig.keywordSummaryUseCustomModel === true);
      setKeywordSummaryModelId(normalizedLlmProfiles.profiles.some(item => item.id === nextLlmConfig.keywordSummaryModelId)
        ? nextLlmConfig.keywordSummaryModelId
        : normalizedLlmProfiles.activeId);
      setImageModels(normalizedImageProfiles.profiles);
      setActiveImageModelId(normalizedImageProfiles.activeId);
      setApiType(DEFAULT_LLM_MODEL_DRAFT.apiType);
      setBaseUrl("");
      setApiKey("");
      setModel("");
      setFirstPacketTimeoutSeconds(Math.max(1, Number(nextLlmConfig.firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds));
      setSupportsImageInput(nextLlmConfig.supportsImageInput === true);
      setSupportsToolImageInput(nextLlmConfig.supportsImageInput === true && (
        Object.prototype.hasOwnProperty.call(nextLlmConfig, "supportsToolImageInput")
          ? nextLlmConfig.supportsToolImageInput === true
          : nextLlmConfig.supportsImageInput === true
      ));
      setReasoningEffort(normalizeReasoningEffort(nextLlmConfig.reasoningEffort));
      setOmitThinkingFromRequests(nextLlmConfig.omitThinkingFromRequests === true);
      setImageBaseUrl("");
      setImageApiKey("");
      setImageApiProtocol(DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol);
      setImageModel("");
      setImageSourceLlmModelId("");
      setImageGenerationModel("");
      setLlmModelFormOpen(false);
      setImageModelFormOpen(false);
      setEditingLlmModelId("");
      setEditingImageModelId("");
      setSubscriptionAvailableModels([]);
      setSelectedSubscriptionModels([]);
      setSubscriptionModelManagerOpen(false);
      setMcpToolTimeoutSeconds(Math.max(1, Number(res.mcpToolTimeoutSeconds) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds));
      setReuse(!!res.reuse);
      setExtractTextLimit(res.extractTextLimit || DEFAULT_SETTINGS.extractTextLimit);
      setBetaFeaturesEnabled(res.betaFeaturesEnabled === true);
      setBridgeEnabled(!!res.bridgeEnabled);
      setWsServerUrl(typeof res.wsServerUrl === "string" ? res.wsServerUrl : "");
      setHideCopyButton(!!res.hideCopyButton);
      setTtsVoiceName(typeof res.ttsVoiceName === "string" ? res.ttsVoiceName : "");
      setDangerousToolSkipApproval(!!res.dangerousToolSkipApproval);
      setPostdogToolsEnabled(!!res.postdogToolsEnabled);
      setSubagentTemplates(normalizeSubagentTemplates(res[SUBAGENT_TEMPLATES_STORAGE_KEY]));
      setMcpServerOptions((res.mcpServers || []).map(server => String(server.name || "").trim()).filter(Boolean));
      setWsBridgeStatus({
        ...DEFAULT_WS_BRIDGE_STATUS,
        ...(res[WS_BRIDGE_STATUS_STORAGE_KEY] || {})
      });
      const supabaseConfig = await loadSupabaseConfig();
      setSupabaseUrl(supabaseConfig.url);
      setSupabaseKey(supabaseConfig.key);
      setSupabaseBucket(supabaseConfig.bucket);
      setSupabaseBasePath(supabaseConfig.basePath);

      const policies = await getReuseDomainPolicies();
      setReusePolicyCount(Object.keys(policies || {}).length);
      setFormKey(prev => prev + 1);
    } finally {
      setLoading(false);
    }
  }

  function closeDialog() {
    const closeButton = rootRef.current?.closest(".dialog-backdrop")?.querySelector(".dialog-close-button");
    closeButton?.click();
  }

  async function handleConfirm() {
    if (hasPendingSettingsDraft()) {
      const shouldDiscardDraft = window.confirm(buildPendingModelDraftMessage());
      if (!shouldDiscardDraft) return;
    }

    setSaving(true);
    try {
      const normalizedWsServerUrl = normalizeWsServerUrlInput(wsServerUrl);
      if (bridgeEnabled && !normalizedWsServerUrl) {
        toast.error("WS Server 地址必须是合法的 ws:// 或 wss:// URL");
        return;
      }

      const { llmConfig: previousLlmConfig = {} } = await chrome.storage.local.get({ llmConfig: {} });
      const nextLlmConfig = normalizeStoredModelConfig({
          ...previousLlmConfig,
          activeLlmModelId,
          llmModels,
          keywordSummaryUseCustomModel,
          keywordSummaryModelId,
          firstPacketTimeoutSeconds: Math.max(1, Number(firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds),
          supportsImageInput,
          supportsToolImageInput: supportsImageInput && supportsToolImageInput,
          reasoningEffort: normalizeReasoningEffort(reasoningEffort),
          omitThinkingFromRequests,
          imageApiProtocol: normalizeImageApiProtocol(imageApiProtocol),
          activeImageModelId,
          imageModels
      });
      const nextSubscriptionIds = new Set(nextLlmConfig.llmModels
        .filter(item => item.apiType === API_TYPES.OPENAI_SUBSCRIPTION)
        .map(item => item.credentialId || item.id));
      const removedSubscriptionIds = normalizeLlmModelProfiles(previousLlmConfig).profiles
        .filter(item => item.apiType === API_TYPES.OPENAI_SUBSCRIPTION && !nextSubscriptionIds.has(item.credentialId || item.id))
        .map(item => item.credentialId || item.id)
        .filter((id, index, all) => all.indexOf(id) === index);

      await chrome.storage.local.set({
        llmConfig: nextLlmConfig,
        mcpToolTimeoutSeconds: Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds),
        reuse,
        extractTextLimit,
        betaFeaturesEnabled,
        bridgeEnabled,
        wsServerUrl: bridgeEnabled ? normalizedWsServerUrl : null,
        hideCopyButton,
        ttsVoiceName,
        dangerousToolSkipApproval,
        postdogToolsEnabled,
        [SUBAGENT_TEMPLATES_STORAGE_KEY]: normalizeSubagentTemplates(subagentTemplates)
      });
      await Promise.all(removedSubscriptionIds.map(profileId => chrome.runtime.sendMessage({
        type: "openai_subscription_oauth",
        action: "remove",
        profileId
      })));
      await saveSupabaseConfig(currentSupabaseConfig());
      toast.success(t("settingsSaved"));
      closeDialog();
    } catch (error) {
      toast.error(`保存失败: ${error?.message || String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  function hasPendingSettingsDraft() {
    return hasPendingLlmModelDraft() || hasPendingImageModelDraft() || subagentTemplateFormOpen;
  }

  function hasPendingLlmModelDraft() {
    return llmModelFormOpen && hasAnyTextValue(baseUrl, apiKey, model);
  }

  function hasPendingImageModelDraft() {
    return imageModelFormOpen && hasAnyTextValue(imageBaseUrl, imageApiKey, imageModel);
  }

  function buildPendingModelDraftMessage() {
    const draftNames = [];
    if (hasPendingLlmModelDraft()) draftNames.push(t("pendingLlmModelDraft"));
    if (hasPendingImageModelDraft()) draftNames.push(t("pendingImageModelDraft"));
    if (subagentTemplateFormOpen) draftNames.push(t("pendingSubagentTemplateDraft"));
    return t("confirmDiscardSettingsDrafts", { names: draftNames.join(locale === "zh" ? "和" : ", ") });
  }

  function currentSupabaseConfig() {
    return {
      url: supabaseUrl,
      key: supabaseKey,
      bucket: supabaseBucket,
      basePath: supabaseBasePath
    };
  }

  async function handleSyncSessionsWithSupabase() {
    setSupabaseRunning(true);
    try {
      await saveSupabaseConfig(currentSupabaseConfig());
      const result = await syncSessionsWithSupabase();
      toast.success(t("supabaseSessionSyncComplete", {
        uploaded: result.uploadedCount,
        downloaded: result.downloadedCount
      }));
    } catch (error) {
      toast.error(t("supabaseSessionSyncFailed", { message: error?.message || String(error) }));
    } finally {
      setSupabaseRunning(false);
    }
  }

  async function handleRestoreSettingsFromSupabase() {
    if (!window.confirm(t("confirmRestoreSettingsFromSupabase"))) return;
    setSupabaseRunning(true);
    try {
      await saveSupabaseConfig(currentSupabaseConfig());
      await restoreSettingsFromSupabase();
      toast.success(t("supabaseSettingsRestoreComplete"));
    } catch (error) {
      toast.error(t("supabaseSettingsRestoreFailed", { message: error?.message || String(error) }));
    } finally {
      setSupabaseRunning(false);
    }
  }

  async function handleOverwriteSupabaseSettings() {
    if (!window.confirm(t("confirmOverwriteSupabaseSettings"))) return;
    setSupabaseRunning(true);
    try {
      await saveSupabaseConfig(currentSupabaseConfig());
      await overwriteSupabaseSettingsFromLocal();
      toast.success(t("supabaseSettingsOverwriteComplete"));
    } catch (error) {
      toast.error(t("supabaseSettingsOverwriteFailed", { message: error?.message || String(error) }));
    } finally {
      setSupabaseRunning(false);
    }
  }

  function handleSupportsImageInputChange(checked) {
    setSupportsImageInput(checked);
    if (!checked) setSupportsToolImageInput(false);
  }

  function handleCancel() {
    void loadDraft();
    closeDialog();
  }

  function handleToggleLlmModelForm() {
    setLlmModelFormOpen(prev => {
      const nextOpen = !prev;
      setEditingLlmModelId("");
      setSubscriptionAvailableModels([]);
      setSelectedSubscriptionModels([]);
      if (nextOpen) {
        const activeProfile = llmModels.find(item => item.id === activeLlmModelId);
        if (activeProfile) {
          setApiType(normalizeApiType(activeProfile.apiType));
          setBaseUrl(activeProfile.baseUrl || "");
          setApiKey(activeProfile.apiKey || "");
          setModel(activeProfile.model || "");
          setNativeWebSearch(activeProfile.nativeWebSearch === true);
        }
      }
      return nextOpen;
    });
  }

  function handleToggleImageModelForm() {
    setImageModelFormOpen(prev => {
      const nextOpen = !prev;
      setEditingImageModelId("");
      if (nextOpen) {
        const activeProfile = imageModels.find(item => item.id === activeImageModelId);
        if (activeProfile) {
          setImageBaseUrl(activeProfile.imageBaseUrl || "");
          setImageApiKey(activeProfile.imageApiKey || "");
          setImageApiProtocol(normalizeImageApiProtocol(activeProfile.imageApiProtocol));
          setImageModel(activeProfile.imageModel || "");
          setImageSourceLlmModelId(activeProfile.sourceLlmModelId || "");
          setImageGenerationModel(activeProfile.imageGenerationModel || "");
        }
      }
      return nextOpen;
    });
  }

  function handleEditLlmModel(profile) {
    setApiType(normalizeApiType(profile.apiType));
    setBaseUrl(profile.baseUrl || "");
    setApiKey(profile.apiKey || "");
    setModel(profile.model || "");
    setNativeWebSearch(profile.nativeWebSearch === true);
    setEditingLlmModelId(profile.id);
    setLlmModelFormOpen(true);
    setSubscriptionModelManagerOpen(false);
    setLlmFormKey(prev => prev + 1);
    if (normalizeApiType(profile.apiType) !== API_TYPES.OPENAI_SUBSCRIPTION) {
      setSubscriptionAvailableModels([]);
      setSelectedSubscriptionModels([]);
    }
  }

  async function loadSubscriptionModels(profile, refresh = false) {
    setSubscriptionModelsLoading(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "openai_subscription_oauth",
        action: "models",
        credentialId: profile.credentialId || profile.id,
        refresh
      });
      if (!response?.success) throw new Error(response?.error || "无法读取模型列表");
      const models = Array.isArray(response.result) ? response.result : [];
      const credentialId = profile.credentialId || profile.id;
      const configured = new Set(llmModels
        .filter(item => item.apiType === API_TYPES.OPENAI_SUBSCRIPTION && (item.credentialId || item.id) === credentialId)
        .map(item => item.model));
      setSubscriptionAvailableModels(models);
      setSelectedSubscriptionModels(models.filter(item => configured.has(item.id)).map(item => item.id));
    } catch (error) {
      toast.error(`读取 OpenAI 模型失败: ${error?.message || String(error)}`);
    } finally {
      setSubscriptionModelsLoading(false);
    }
  }

  async function handleAddSelectedSubscriptionModels() {
    const sourceProfile = llmModels.find(item => item.id === editingLlmModelId);
    if (!sourceProfile) return;
    const selected = subscriptionAvailableModels.filter(item => selectedSubscriptionModels.includes(item.id));
    if (selected.length === 0) {
      toast.error("请至少选择一个模型");
      return;
    }
    const credentialId = sourceProfile.credentialId || sourceProfile.id;
    const existingModels = new Set(llmModels
      .filter(item => (item.credentialId || item.id) === credentialId)
      .map(item => item.model));
    const additions = selected.filter(item => !existingModels.has(item.id)).map(item => ({
      id: createModelProfileId("llm"),
      name: `OpenAI · ${item.name || item.id}`,
      apiType: API_TYPES.OPENAI_SUBSCRIPTION,
      baseUrl: "",
      apiKey: "",
      model: item.id,
      nativeWebSearch: true,
      credentialId,
      accountId: sourceProfile.accountId || "",
      email: sourceProfile.email || "",
      planType: sourceProfile.planType || "",
      requiresApiKey: false
    }));
    if (additions.length === 0) {
      toast.success("所选模型已经添加");
      return;
    }
    const nextModels = dedupeSubscriptionProfiles([...llmModels, ...additions]);
    const { llmConfig = {} } = await chrome.storage.local.get({ llmConfig: {} });
    await chrome.storage.local.set({
      llmConfig: normalizeStoredModelConfig({ ...llmConfig, llmModels: nextModels, activeLlmModelId })
    });
    setLlmModels(nextModels);
    toast.success(`已添加 ${additions.length} 个模型`);
  }

  function handleEditImageModel(profile) {
    setImageBaseUrl(profile.imageBaseUrl || "");
    setImageApiKey(profile.imageApiKey || "");
    setImageApiProtocol(normalizeImageApiProtocol(profile.imageApiProtocol));
    setImageModel(profile.imageModel || "");
    setImageSourceLlmModelId(profile.sourceLlmModelId || "");
    setImageGenerationModel(profile.imageGenerationModel || "");
    setEditingImageModelId(profile.id);
    setImageModelFormOpen(true);
    setImageFormKey(prev => prev + 1);
  }

  async function handleAddLlmModel() {
    const trimmedBaseUrl = String(baseUrl || "").trim();
    const trimmedApiKey = String(apiKey || "").trim();
    const trimmedModel = String(model || "").trim();
    const normalizedType = normalizeApiType(apiType);
    const subscription = normalizedType === API_TYPES.OPENAI_SUBSCRIPTION;
    if (!trimmedModel || (!subscription && (!trimmedBaseUrl || !trimmedApiKey))) {
      toast.error("API 地址、API Key 和模型不能为空");
      return;
    }
    const profileId = editingLlmModelId || createModelProfileId("llm");
    const existingProfile = llmModels.find(item => item.id === editingLlmModelId);
    if (subscription && !existingProfile?.accountId) {
      setOpenAiLoginPending(true);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "openai_subscription_oauth",
          action: "authorize",
          profileId,
          model: trimmedModel
        });
        if (!response?.success) throw new Error(response?.error || "无法开始 OAuth 登录");
        toast.success("已打开 OpenAI 登录页面");
      } catch (error) {
        setOpenAiLoginPending(false);
        toast.error(`OpenAI 登录失败: ${error?.message || String(error)}`);
      }
      return;
    }
    const profile = {
      id: profileId,
      name: subscription ? (existingProfile?.name || "OpenAI Subscription") : trimmedModel,
      apiType: normalizedType,
      baseUrl: subscription ? "" : trimmedBaseUrl,
      apiKey: subscription ? "" : trimmedApiKey,
      model: trimmedModel,
      nativeWebSearch: [API_TYPES.OPENAI_RESPONSES, API_TYPES.OPENAI_SUBSCRIPTION].includes(normalizedType) && nativeWebSearch,
      ...(subscription ? {
        credentialId: existingProfile.credentialId || existingProfile.id,
        accountId: existingProfile.accountId || "",
        email: existingProfile.email || "",
        planType: existingProfile.planType || "",
        requiresApiKey: false
      } : {})
    };
    try {
      const res = await chrome.storage.local.get({ llmConfig: DEFAULT_SETTINGS.llmConfig });
      const rawStoredConfig = res.llmConfig || {};
      const storedConfig = { ...DEFAULT_SETTINGS.llmConfig, ...rawStoredConfig };
      const storedProfiles = normalizeLlmModelProfiles(rawStoredConfig);
      const nextModels = dedupeSubscriptionProfiles(editingLlmModelId
        ? storedProfiles.profiles.map(item => item.id === editingLlmModelId ? profile : item)
        : [...storedProfiles.profiles, profile]);
      const nextActiveLlmModelId = storedProfiles.activeId || profile.id;
      const nextLlmConfig = normalizeStoredModelConfig({
        ...storedConfig,
        llmModels: nextModels,
        activeLlmModelId: nextActiveLlmModelId
      });
      await chrome.storage.local.set({ llmConfig: nextLlmConfig });
      if (existingProfile?.apiType === API_TYPES.OPENAI_SUBSCRIPTION && !subscription) {
        const credentialStillUsed = nextLlmConfig.llmModels.some(item =>
          item.apiType === API_TYPES.OPENAI_SUBSCRIPTION && item.credentialId === existingProfile.credentialId);
        if (!credentialStillUsed) {
          await chrome.runtime.sendMessage({
            type: "openai_subscription_oauth",
            action: "remove",
            profileId: existingProfile.credentialId || existingProfile.id
          });
        }
      }
      setLlmModels(prev => dedupeSubscriptionProfiles(editingLlmModelId
        ? prev.map(item => item.id === editingLlmModelId ? profile : item)
        : [...prev, profile]));
      if (!activeLlmModelId) setActiveLlmModelId(profile.id);
      toast.success(editingLlmModelId ? "模型已修改" : "模型已添加");
    } catch (error) {
      toast.error(`${editingLlmModelId ? "修改" : "添加"}模型失败: ${error?.message || String(error)}`);
      return;
    }
    setApiType(DEFAULT_LLM_MODEL_DRAFT.apiType);
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setNativeWebSearch(false);
    setSubscriptionModelManagerOpen(false);
    setLlmModelFormOpen(false);
    setEditingLlmModelId("");
    setLlmFormKey(prev => prev + 1);
  }

  function handleRemoveLlmModel(id) {
    setLlmModels(prev => {
      const next = prev.filter(item => item.id !== id);
      if (activeLlmModelId === id) {
        setActiveLlmModelId(next[0]?.id || "");
      }
      return next;
    });
    if (editingLlmModelId === id) {
      setEditingLlmModelId("");
      setLlmModelFormOpen(false);
    }
  }

  async function handleAddImageModel() {
    const trimmedBaseUrl = String(imageBaseUrl || "").trim();
    const trimmedApiKey = String(imageApiKey || "").trim();
    const trimmedModel = String(imageModel || "").trim();
    const builtin = imageApiProtocol === IMAGE_API_PROTOCOLS.OPENAI_BUILTIN;
    const sourceProfile = builtinImageHostModels.find(item => item.id === imageSourceLlmModelId);
    if ((builtin && !sourceProfile) || (!builtin && (!trimmedBaseUrl || !trimmedApiKey || !trimmedModel))) {
      toast.error("Image API 地址、Token 和模型不能为空");
      return;
    }
    const effectiveModel = builtin ? (imageGenerationModel || `${sourceProfile.model}-built-in`) : trimmedModel;
    const profile = {
      id: editingImageModelId || createImageModelProfileId(effectiveModel),
      name: effectiveModel,
      imageBaseUrl: builtin ? "" : trimmedBaseUrl,
      imageApiKey: builtin ? "" : trimmedApiKey,
      imageApiProtocol: normalizeImageApiProtocol(imageApiProtocol),
      imageModel: effectiveModel,
      ...(builtin ? { sourceLlmModelId: sourceProfile.id, imageGenerationModel } : {})
    };
    try {
      const res = await chrome.storage.local.get({ llmConfig: DEFAULT_SETTINGS.llmConfig });
      const rawStoredConfig = res.llmConfig || {};
      const storedConfig = { ...DEFAULT_SETTINGS.llmConfig, ...rawStoredConfig };
      const storedProfiles = normalizeImageModelProfiles(rawStoredConfig);
      const nextModels = editingImageModelId
        ? storedProfiles.profiles.map(item => item.id === editingImageModelId ? profile : item)
        : [...storedProfiles.profiles, profile];
      const nextActiveImageModelId = storedProfiles.activeId || profile.id;
      const nextLlmConfig = normalizeStoredModelConfig({
        ...storedConfig,
        imageModels: nextModels,
        activeImageModelId: nextActiveImageModelId
      });
      await chrome.storage.local.set({ llmConfig: nextLlmConfig });
      setImageModels(prev => editingImageModelId
        ? prev.map(item => item.id === editingImageModelId ? profile : item)
        : [...prev, profile]);
      if (!activeImageModelId) setActiveImageModelId(profile.id);
      toast.success(editingImageModelId ? "图片模型已修改" : "图片模型已添加");
    } catch (error) {
      toast.error(`${editingImageModelId ? "修改" : "添加"}图片模型失败: ${error?.message || String(error)}`);
      return;
    }
    setImageBaseUrl("");
    setImageApiKey("");
    setImageApiProtocol(DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol);
    setImageModel("");
    setImageSourceLlmModelId("");
    setImageGenerationModel("");
    setImageModelFormOpen(false);
    setEditingImageModelId("");
    setImageFormKey(prev => prev + 1);
  }

  function handleRemoveImageModel(id) {
    setImageModels(prev => {
      const next = prev.filter(item => item.id !== id);
      if (activeImageModelId === id) {
        setActiveImageModelId(next[0]?.id || "");
      }
      return next;
    });
    if (editingImageModelId === id) {
      setEditingImageModelId("");
      setImageModelFormOpen(false);
    }
  }

  async function handleClearReusePolicies() {
    await clearReuseDomainPolicies();
    setReusePolicyCount(0);
    toast.success("已清空域名复用记忆");
  }

  async function handleScreenshotCurrentPage() {
    const toastId = toast.loading("正在截取当前页面...");
    try {
      const result = await captureFullPageScreenshotToTab({ fullPage: true });
      toast.dismiss(toastId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success("截图完成");
    } catch (error) {
      toast.dismiss(toastId);
      toast.error(error?.message || "截图失败");
    }
  }

  async function handleOpenPlayground() {
    try {
      const result = await openHelloWorldPlayground();
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success("已打开 Playground");
    } catch (error) {
      toast.error(error?.message || "打开 Playground 失败");
    }
  }

  async function handleOpenStash() {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("stash.html") });
      toast.success("已打开 Stash");
    } catch (error) {
      toast.error(error?.message || "打开 Stash 失败");
    }
  }

  async function handleOpenAdvancedUsage() {
    try {
      await chrome.tabs.create({ url: ADVANCED_USAGE_URL });
      toast.success("已打开高级用法");
    } catch (error) {
      toast.error(error?.message || "打开高级用法失败");
    }
  }

  async function handleOpenPostdog() {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("postdog.html") });
      closeDialog();
      toast.success("已打开 Postdog");
    } catch (error) {
      toast.error(error?.message || "打开 Postdog 失败");
    }
  }

  async function handleOpenHooks() {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("hooks.html") });
    } catch (error) {
      toast.error(error?.message || "打开 Hook 设置失败");
    }
  }

  function openNewSubagentTemplateForm() {
    setEditingSubagentTemplateId("");
    setSubagentTemplateDraft(createEmptySubagentTemplate());
    setSubagentTemplateFormOpen(true);
  }

  function openEditSubagentTemplateForm(template) {
    setEditingSubagentTemplateId(template.id);
    setSubagentTemplateDraft({ ...template, allowedBuiltinDomains: [...template.allowedBuiltinDomains], allowedMcpServers: [...template.allowedMcpServers] });
    setSubagentTemplateFormOpen(true);
  }

  async function saveSubagentTemplateDraft() {
    const templateName = String(subagentTemplateDraft.templateName || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(templateName)) {
      toast.error("Template name must start with an English letter and contain only English letters, numbers, or underscores.");
      return;
    }
    if (subagentTemplates.some(item => item.templateName === templateName && item.id !== editingSubagentTemplateId)) {
      toast.error("Template name must be unique.");
      return;
    }
    const normalized = normalizeSubagentTemplates([{ ...subagentTemplateDraft, id: editingSubagentTemplateId || subagentTemplateDraft.templateName }])[0];
    if (!normalized?.templateName) {
      toast.error(t("subagentTemplateNameRequired"));
      return;
    }
    if (!normalized.description) {
      toast.error(t("subagentTemplateDescriptionRequired"));
      return;
    }
    const nextTemplates = normalizeSubagentTemplates(editingSubagentTemplateId
      ? subagentTemplates.map(item => item.id === editingSubagentTemplateId ? normalized : item)
      : [...subagentTemplates, normalized]
    );
    try {
      await chrome.storage.local.set({ [SUBAGENT_TEMPLATES_STORAGE_KEY]: nextTemplates });
      setSubagentTemplates(nextTemplates);
      toast.success(t("subagentTemplateSaved"));
    } catch (error) {
      toast.error(t("subagentTemplateSaveFailed", { message: error?.message || String(error) }));
      return;
    }
    setSubagentTemplateFormOpen(false);
    setEditingSubagentTemplateId("");
  }

  function removeSubagentTemplate(id) {
    setSubagentTemplates(current => current.filter(item => item.id !== id));
    if (editingSubagentTemplateId === id) setSubagentTemplateFormOpen(false);
  }

  async function handleExportSettings() {
    try {
      const backup = await exportSettingsBackup();
      downloadSettingsBackup(backup);
      toast.success("配置已导出");
    } catch (error) {
      toast.error(`导出配置失败: ${error?.message || String(error)}`);
    }
  }

  function handleImportSettingsClick() {
    settingsImportInputRef.current?.click();
  }

  async function handleImportSettingsFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const result = await importSettingsBackupFromText(text);
      await loadDraft();
      const updatedCount = result.updatedKeys.length;
      toast.success(updatedCount > 0 ? `配置已导入（${updatedCount} 项）` : "未发现可导入的配置项");
    } catch (error) {
      toast.error(`导入配置失败: ${error?.message || String(error)}`);
    }
  }

  const wsBridgeStateMeta = getWsBridgeStateMeta(wsBridgeStatus.state);
  const wsBridgeLastHeartbeat = formatWsBridgeStatusTime(wsBridgeStatus.lastHeartbeatAckAt);

  return (
    <div ref={(node) => {
      rootRef.current = node;
      localizedRootRef(node);
    }} key={formKey} className="settings-dialog-body">
      <div className="settings-dialog-scroll">
        <div className="settings-card">
          <div className="settings-card-title">LLM 配置</div>
          <div className="settings-model-badges" aria-label="已保存 LLM 模型">
            {llmModels.length === 0 ? (
              <span className="settings-model-empty">暂无模型</span>
            ) : llmModels.map(item => (
              <button
                key={item.id}
                type="button"
                className={`settings-model-badge${item.id === activeLlmModelId ? " settings-model-badge-active" : ""}${item.id === editingLlmModelId ? " settings-model-badge-editing" : ""}`}
                onClick={() => setActiveLlmModelId(item.id)}
                title={`${item.name}\n${item.apiType}\n${item.baseUrl}`}
              >
                <span className="settings-model-badge-name">{item.name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="settings-model-badge-remove"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRemoveLlmModel(item.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    handleRemoveLlmModel(item.id);
                  }}
                  aria-label={`删除 ${item.name}`}
                  title="删除"
                >
                  ×
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="settings-model-badge-edit"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleEditLlmModel(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    handleEditLlmModel(item);
                  }}
                  aria-label={`编辑 ${item.name}`}
                  title="编辑"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
          <Button
            className="settings-model-add-toggle bg-[var(--w-indigo)]"
            onPress={handleToggleLlmModelForm}
          >
            {llmModelFormOpen ? (editingLlmModelId ? "取消编辑" : "收起添加模型") : "添加模型"}
          </Button>
          <div className="mt-3">
            <Checkbox isSelected={keywordSummaryUseCustomModel} onChange={setKeywordSummaryUseCustomModel}>
              <span className="text-sm">使用自定义关键词总结模型</span>
            </Checkbox>
          </div>
          {keywordSummaryUseCustomModel && (
            <Select
              label="关键词总结模型"
              items={llmModels.map(item => `${item.name} (${item.model})`)}
              defaultIndex={Math.max(0, llmModels.findIndex(item => item.id === keywordSummaryModelId))}
              onSelectedItemChange={(changes) => {
                const selected = llmModels.find(item => `${item.name} (${item.model})` === changes.selectedItem);
                if (selected) setKeywordSummaryModelId(selected.id);
              }}
            />
          )}
          {!keywordSummaryUseCustomModel && (
            <div className="settings-api-url-hint">关键词总结默认使用当前聊天模型</div>
          )}
          {llmModelFormOpen && (
            <div key={llmFormKey} className="settings-model-form">
              <Select
                label="API 类型"
                items={["OpenAI Chat Completions", "OpenAI Responses", "OpenAI Subscription", "Anthropic"]}
                defaultIndex={apiType === API_TYPES.OPENAI_RESPONSES ? 1 : (apiType === API_TYPES.OPENAI_SUBSCRIPTION ? 2 : (apiType === API_TYPES.ANTHROPIC ? 3 : 0))}
                onSelectedItemChange={(changes) => {
                  const selected = changes.selectedItem;
                  if (selected === "Anthropic") {
                    setApiType(API_TYPES.ANTHROPIC);
                  } else if (selected === "OpenAI Subscription") {
                    setApiType(API_TYPES.OPENAI_SUBSCRIPTION);
                    setNativeWebSearch(true);
                  } else if (selected === "OpenAI Responses") {
                    setApiType(API_TYPES.OPENAI_RESPONSES);
                  } else {
                    setApiType(API_TYPES.OPENAI_CHAT_COMPLETIONS);
                  }
                }}
              />
              {apiType === API_TYPES.OPENAI_SUBSCRIPTION ? (
                <div className="settings-api-url-hint">
                  使用 ChatGPT 订阅登录，API 地址由 OpenAI 固定提供，不需要填写 API Key。
                  {editingLlmModelId && llmModels.find(item => item.id === editingLlmModelId)?.email
                    ? ` 当前账号：${llmModels.find(item => item.id === editingLlmModelId)?.email}`
                    : ""}
                </div>
              ) : (<>
                <Input
                  label="API 地址"
                  labelClassName="!text-sm !font-medium !text-gray-500"
                  inputClassName="!min-h-8"
                  defaultValue={baseUrl}
                  onChange={setBaseUrl}
                  placeholder={apiType === API_TYPES.ANTHROPIC ? "https://api.deepseek.com/anthropic/messages" : (apiType === API_TYPES.OPENAI_RESPONSES ? "https://api.openai.com/v1/responses" : "https://api.deepseek.com/chat/completions")}
                />
                <div className="settings-api-url-hint">
                  finalURL: {resolvedApiUrl || "—"}
                </div>
                <div className="settings-secret-field">
                <label className="!text-sm !font-medium !text-gray-500" htmlFor="settings-api-key">API Key</label>
                <div className="settings-secret-input-wrapper">
                  <input
                    id="settings-api-key"
                    className="settings-secret-input !min-h-8"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={apiType === API_TYPES.ANTHROPIC ? "sk-ant-..." : "sk-..."}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="settings-secret-toggle"
                    onClick={() => setShowApiKey((prev) => !prev)}
                    aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                    title={showApiKey ? "隐藏" : "显示"}
                  >
                    {showApiKey ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M3 3L21 21M10.6 10.7A3 3 0 0 0 13.3 13.4M9.9 5.1A10.9 10.9 0 0 1 12 4.9C17 4.9 21 12 21 12A20.6 20.6 0 0 1 17.4 16.6M14.1 14.3A3 3 0 0 1 9.7 9.9M6.5 7.5A20.3 20.3 0 0 0 3 12S7 19.1 12 19.1C13.3 19.1 14.5 18.8 15.6 18.3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M2.5 12S6.5 5 12 5s9.5 7 9.5 7-4 7-9.5 7S2.5 12 2.5 12Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle
                          cx="12"
                          cy="12"
                          r="3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        />
                      </svg>
                    )}
                  </button>
                </div>
                </div>
              </>)}
              <Input
                label="模型"
                labelClassName="!text-sm !font-medium !text-gray-500"
                inputClassName="!min-h-8"
                defaultValue={model}
                onChange={setModel}
                placeholder={apiType === API_TYPES.ANTHROPIC
                  ? "claude-sonnet-4-20250514"
                  : ([API_TYPES.OPENAI_RESPONSES, API_TYPES.OPENAI_SUBSCRIPTION].includes(apiType) ? "gpt-5-codex" : "deepseek-v4-flash")}
              />
              {[API_TYPES.OPENAI_RESPONSES, API_TYPES.OPENAI_SUBSCRIPTION].includes(apiType) && (
                <Checkbox isSelected={nativeWebSearch} onChange={setNativeWebSearch}>
                  <span className="text-sm">启用 OpenAI 内置 Web Search</span>
                </Checkbox>
              )}
              {apiType === API_TYPES.OPENAI_SUBSCRIPTION && editingLlmModelId && !subscriptionModelManagerOpen && (
                <Button className="settings-model-add-button" isDisabled={subscriptionModelsLoading} onPress={() => {
                  const profile = llmModels.find(item => item.id === editingLlmModelId);
                  if (!profile) return;
                  setSubscriptionModelManagerOpen(true);
                  void loadSubscriptionModels(profile, true);
                }}>
                  管理此账号的模型
                </Button>
              )}
              {apiType === API_TYPES.OPENAI_SUBSCRIPTION && editingLlmModelId && subscriptionModelManagerOpen && (
                <div className="settings-subscription-models">
                  <div className="settings-inline-section-title">可用订阅模型</div>
                  {subscriptionModelsLoading ? (
                    <div className="settings-api-url-hint">正在读取模型列表...</div>
                  ) : subscriptionAvailableModels.length === 0 ? (
                    <div className="settings-api-url-hint">暂时没有读取到模型列表，可刷新后重试。</div>
                  ) : subscriptionAvailableModels.map(item => (
                    <Checkbox
                      key={item.id}
                      isSelected={selectedSubscriptionModels.includes(item.id)}
                      onChange={(selected) => setSelectedSubscriptionModels(current => selected
                        ? [...new Set([...current, item.id])]
                        : current.filter(id => id !== item.id))}
                    >
                      <span className="text-sm" title={item.description || item.id}>{item.name || item.id}</span>
                    </Checkbox>
                  ))}
                  <div className="settings-model-action-row">
                    <Button className="settings-model-add-button" isDisabled={subscriptionModelsLoading} onPress={() => {
                      const profile = llmModels.find(item => item.id === editingLlmModelId);
                      if (profile) void loadSubscriptionModels(profile, true);
                    }}>
                      刷新列表
                    </Button>
                    <Button className="settings-model-add-button bg-[var(--w-indigo)]" isDisabled={subscriptionModelsLoading} onPress={handleAddSelectedSubscriptionModels}>
                      添加所选模型
                    </Button>
                  </div>
                </div>
              )}
              {apiType === API_TYPES.OPENAI_SUBSCRIPTION && editingLlmModelId && (
                <SubscriptionUsage profile={llmModels.find(item => item.id === editingLlmModelId)} />
              )}
              {apiType === API_TYPES.OPENAI_SUBSCRIPTION && editingLlmModelId && (
                <Button
                  className="settings-model-add-button"
                  isDisabled={openAiLoginPending}
                  onPress={async () => {
                    setOpenAiLoginPending(true);
                    try {
                      const response = await chrome.runtime.sendMessage({
                        type: "openai_subscription_oauth",
                        action: "authorize",
                        profileId: editingLlmModelId,
                        model: String(model || "").trim()
                      });
                      if (!response?.success) throw new Error(response?.error || "无法开始 OAuth 登录");
                      toast.success("已打开 OpenAI 登录页面");
                    } catch (error) {
                      setOpenAiLoginPending(false);
                      toast.error(error?.message || "无法开始 OAuth 登录");
                    }
                  }}
                >
                  重新登录
                </Button>
              )}
              <Button className="settings-model-add-button bg-[var(--w-indigo)]" isDisabled={openAiLoginPending} onPress={handleAddLlmModel}>
                {openAiLoginPending
                  ? "等待登录..."
                  : (apiType === API_TYPES.OPENAI_SUBSCRIPTION && !editingLlmModelId
                    ? "登录并添加"
                    : (editingLlmModelId ? "保存修改" : "添加"))}
              </Button>
            </div>
          )}
          <Input
            label="LLM 首包超时（秒）"
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={String(firstPacketTimeoutSeconds)}
            onChange={(value) => {
              setFirstPacketTimeoutSeconds(Math.max(1, parseInt(value || String(DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds), 10) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds));
            }}
            placeholder="20"
          />
          <div className="mt-2">
            <Checkbox isSelected={omitThinkingFromRequests} onChange={setOmitThinkingFromRequests}>
              <span className="text-sm">思考内容不回传（需供应商支持）</span>
            </Checkbox>
          </div>
          <Input
            label="MCP 工具超时（秒）"
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={String(mcpToolTimeoutSeconds)}
            onChange={(value) => {
              setMcpToolTimeoutSeconds(Math.max(1, parseInt(value || String(DEFAULT_SETTINGS.mcpToolTimeoutSeconds), 10) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds));
            }}
            placeholder="60"
          />
          <Select
            label="页面内容读取的最大长度"
            items={extractTextLimitOptions.map((item) => item.label)}
            defaultIndex={Math.max(0, extractTextLimitOptions.findIndex((item) => item.value === extractTextLimit))}
            onSelectedItemChange={(changes) => {
              const selected = extractTextLimitOptions.find((item) => item.label === changes.selectedItem);
              setExtractTextLimit(selected ? selected.value : DEFAULT_SETTINGS.extractTextLimit);
            }}
          />
          <div className="mt-2">
            <Checkbox isSelected={supportsImageInput} onChange={handleSupportsImageInputChange}>
              <span className="text-sm">模型支持用户图片输入</span>
            </Checkbox>
          </div>
          <div className="mt-2">
            <Checkbox
              isSelected={supportsImageInput && supportsToolImageInput}
              onChange={(checked) => setSupportsToolImageInput(checked && supportsImageInput)}
            >
              <span className="text-sm">模型支持工具图片输入</span>
            </Checkbox>
            {!supportsImageInput && (
              <div className="text-xs text-gray-500 mt-1">需要先开启用户图片输入。</div>
            )}
          </div>
          <div className="settings-inline-section-title">Image API 配置</div>
          <div className="settings-model-badges" aria-label="已保存图片模型">
            {imageModels.length === 0 ? (
              <span className="settings-model-empty">暂无图片模型</span>
            ) : imageModels.map(item => (
              <button
                key={item.id}
                type="button"
                className={`settings-model-badge settings-image-model-badge${item.id === activeImageModelId ? " settings-model-badge-active" : ""}${item.id === editingImageModelId ? " settings-model-badge-editing" : ""}`}
                onClick={() => setActiveImageModelId(item.id)}
                title={`${item.name}\n${item.imageApiProtocol}\n${item.imageBaseUrl}`}
              >
                <span className="settings-model-badge-name">{item.name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="settings-model-badge-remove"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRemoveImageModel(item.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    handleRemoveImageModel(item.id);
                  }}
                  aria-label={`删除 ${item.name}`}
                  title="删除"
                >
                  ×
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="settings-model-badge-edit"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleEditImageModel(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    handleEditImageModel(item);
                  }}
                  aria-label={`编辑 ${item.name}`}
                  title="编辑"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
          <Button
            className="settings-model-add-toggle bg-[var(--w-green)]"
            onPress={handleToggleImageModelForm}
          >
            {imageModelFormOpen ? (editingImageModelId ? "取消编辑" : "收起添加图片模型") : "添加图片模型"}
          </Button>
          {imageModelFormOpen && (
            <div key={imageFormKey} className="settings-model-form">
              <Select
                label="Image API 规范"
                items={imageProtocolOptions.map((item) => item.label)}
                defaultIndex={Math.max(0, imageProtocolOptions.findIndex((item) => item.value === imageApiProtocol))}
                onSelectedItemChange={(changes) => {
                  const selected = imageProtocolOptions.find((item) => item.label === changes.selectedItem);
                  const nextProtocol = selected ? selected.value : DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol;
                  setImageApiProtocol(nextProtocol);
                  if (nextProtocol === IMAGE_API_PROTOCOLS.OPENAI_BUILTIN && !imageSourceLlmModelId) {
                    setImageSourceLlmModelId(builtinImageHostModels[0]?.id || "");
                  }
                }}
              />
              {imageApiProtocol === IMAGE_API_PROTOCOLS.OPENAI_BUILTIN ? (
                <>
                  <Select
                    label="OpenAI 宿主模型"
                    items={builtinImageHostModels.map(item => `${item.name} (${item.model})`)}
                    defaultIndex={Math.max(0, builtinImageHostModels.findIndex(item => item.id === imageSourceLlmModelId))}
                    onSelectedItemChange={(changes) => {
                      const selected = builtinImageHostModels.find(item => `${item.name} (${item.model})` === changes.selectedItem);
                      setImageSourceLlmModelId(selected?.id || "");
                    }}
                  />
                  <Select
                    label="图片生成模型"
                    items={OPENAI_IMAGE_GENERATION_MODELS.map(item => item.label)}
                    defaultIndex={Math.max(0, OPENAI_IMAGE_GENERATION_MODELS.findIndex(item => item.value === imageGenerationModel))}
                    onSelectedItemChange={(changes) => {
                      const selected = OPENAI_IMAGE_GENERATION_MODELS.find(item => item.label === changes.selectedItem);
                      setImageGenerationModel(selected?.value || "");
                    }}
                  />
                  <div className="settings-api-url-hint">{t("imageGenerationModelAccountHint")}</div>
                  {builtinImageHostModels.length === 0 && (
                    <div className="settings-api-url-hint">请先添加 OpenAI Responses 或 OpenAI Subscription 模型。</div>
                  )}
                  <div className="settings-api-url-hint">
                    {t("openAiBuiltinImageGenHint")}
                  </div>
                </>
              ) : (<>
              <Input
                label="Image API 地址"
                labelClassName="!text-sm !font-medium !text-gray-500"
                inputClassName="!min-h-8"
                defaultValue={imageBaseUrl}
                onChange={setImageBaseUrl}
                placeholder="https://api.openai.com/v1"
              />
              <div className="settings-api-url-hint">
                {imageApiProtocol === IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS
                  ? `Chat Completions ${resolvedImageChatUrl || "—"}`
                  : `gen: ${resolvedImageGenUrl || "—"}; edit: ${resolvedImageEditUrl || "—"}`}
              </div>
              <div className="settings-secret-field">
                <label className="!text-sm !font-medium !text-gray-500" htmlFor="settings-image-api-key">Image API Token</label>
                <div className="settings-secret-input-wrapper">
                  <input
                    id="settings-image-api-key"
                    className="settings-secret-input !min-h-8"
                    type={showImageApiKey ? "text" : "password"}
                    value={imageApiKey}
                    onChange={(e) => setImageApiKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="settings-secret-toggle"
                    onClick={() => setShowImageApiKey((prev) => !prev)}
                    aria-label={showImageApiKey ? "隐藏 Image API Token" : "显示 Image API Token"}
                    title={showImageApiKey ? "隐藏" : "显示"}
                  >
                    {showImageApiKey ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M3 3L21 21M10.6 10.7A3 3 0 0 0 13.3 13.4M9.9 5.1A10.9 10.9 0 0 1 12 4.9C17 4.9 21 12 21 12A20.6 20.6 0 0 1 17.4 16.6M14.1 14.3A3 3 0 0 1 9.7 9.9M6.5 7.5A20.3 20.3 0 0 0 3 12S7 19.1 12 19.1C13.3 19.1 14.5 18.8 15.6 18.3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M2.5 12S6.5 5 12 5s9.5 7 9.5 7-4 7-9.5 7S2.5 12 2.5 12Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle
                          cx="12"
                          cy="12"
                          r="3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <Input
                label="Image 模型"
                labelClassName="!text-sm !font-medium !text-gray-500"
                inputClassName="!min-h-8"
                defaultValue={imageModel}
                onChange={setImageModel}
                placeholder={DEFAULT_IMAGE_MODEL}
              />
              </>)}
              <Button className="settings-model-add-button bg-[var(--w-green)]" onPress={handleAddImageModel}>
                {editingImageModelId ? "保存修改" : "添加"}
              </Button>
            </div>
          )}
          <div className="mt-2">
            <Checkbox isSelected={hideCopyButton} onChange={setHideCopyButton}>
              <span className="text-sm">隐藏助手消息的操作按钮（复制 / 播报）</span>
            </Checkbox>
          </div>
          <Select
            label="助手消息播报音色"
            items={ttsVoiceOptions.map((item) => item.label)}
            defaultIndex={Math.max(0, ttsVoiceOptions.findIndex((item) => item.value === ttsVoiceName))}
            onSelectedItemChange={(changes) => {
              const selected = ttsVoiceOptions.find((item) => item.label === changes.selectedItem);
              setTtsVoiceName(selected ? selected.value : DEFAULT_SETTINGS.ttsVoiceName);
            }}
          />
          <div className="settings-api-url-hint">
            使用浏览器内置语音合成；不同系统和浏览器可用音色不同。
          </div>
          <div className="mt-2">
            <Checkbox isSelected={dangerousToolSkipApproval} onChange={setDangerousToolSkipApproval}>
              <span className="text-sm text-red-600">危险工具无需审批（危险）</span>
            </Checkbox>
          </div>
          <div className="mt-2">
            <Checkbox isSelected={postdogToolsEnabled} onChange={setPostdogToolsEnabled}>
              <span className="text-sm">开启 Postdog 工具</span>
            </Checkbox>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">标签管理</div>
          <div className="mt-2">
            <Checkbox isSelected={reuse} onChange={setReuse}>
              <span className="text-sm">复用 Tab</span>
            </Checkbox>
          </div>
          <div className="settings-reuse-memory-row">
            <span className="text-xs text-gray-500">
              {locale === "en"
                ? `Remembered reuse choices for ${reusePolicyCount} domains`
                : `已记住 ${reusePolicyCount} 个域名的复用决策`}
            </span>
            <Button
              className="!min-h-6 !px-2 !py-0 !text-xs"
              isDisabled={reusePolicyCount === 0}
              onPress={handleClearReusePolicies}
            >
              清空域名复用记忆
            </Button>
          </div>
          <div className="mt-2">
            <Checkbox isSelected={betaFeaturesEnabled} onChange={setBetaFeaturesEnabled}>
              <span className="text-sm">开启 Beta 功能</span>
            </Checkbox>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">{t("memoryTitle")}</div>
          <div className="settings-reuse-memory-row">
            <span className="text-xs text-gray-500">{t("memorySettingsHint")}</span>
            <MemoryManager />
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">工具透出</div>
          <div className="mt-2">
            <Checkbox isSelected={bridgeEnabled} onChange={setBridgeEnabled}>
              <span className="text-sm">开启工具透出</span>
            </Checkbox>
          </div>
          <Input
            aria-label="WS Server URL"
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={wsServerUrl}
            onChange={setWsServerUrl}
            placeholder="ws://localhost:3000/ws/tabmanager"
          />
          <div className="settings-api-url-hint">
            Bridge 状态
            {" "}
            <span style={{ color: wsBridgeStateMeta.color }}>{wsBridgeStateMeta.label}</span>
            {wsBridgeStatus.tools > 0 ? ` · ${wsBridgeStatus.tools} 个工具` : ""}
            {wsBridgeStatus.error ? ` · ${wsBridgeStatus.error}` : ""}
            {wsBridgeLastHeartbeat ? ` · 最近心跳 ${wsBridgeLastHeartbeat}` : ""}
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">{t("subagentTemplates")}</div>
          <div className="settings-subagent-template-list">
            {subagentTemplates.length === 0 ? <span className="settings-model-empty">{t("subagentNoTemplates")}</span> : subagentTemplates.map(template => (
              <div key={template.id} className="settings-subagent-template-row">
                <div>
                  <strong>{template.templateName}</strong>
                  <div className="settings-api-url-hint">{template.description}</div>
                </div>
                <div className="settings-subagent-template-actions">
                  <Button className="!min-h-7 !px-2 !py-0 !text-xs" onPress={() => openEditSubagentTemplateForm(template)}>{t("subagentEditTemplate")}</Button>
                  <Button className="!min-h-7 !px-2 !py-0 !text-xs" onPress={() => removeSubagentTemplate(template.id)}>{t("subagentDeleteTemplate")}</Button>
                </div>
              </div>
            ))}
          </div>
          <Button className="settings-model-add-toggle bg-[var(--w-indigo)]" onPress={subagentTemplateFormOpen ? () => setSubagentTemplateFormOpen(false) : openNewSubagentTemplateForm}>
            {subagentTemplateFormOpen ? t("subagentHideTemplateForm") : t("subagentAddTemplate")}
          </Button>
          {subagentTemplateFormOpen && (
            <div className="settings-model-form">
              <Input label={t("subagentTemplateName")} labelClassName="!text-sm !font-medium !text-gray-500" inputClassName="!min-h-8" value={subagentTemplateDraft.templateName} onChange={value => setSubagentTemplateDraft(current => ({ ...current, templateName: value }))} placeholder={t("subagentTemplateNamePlaceholder")} />
              <Input label={t("subagentTemplateDescription")} labelClassName="!text-sm !font-medium !text-gray-500" inputClassName="!min-h-8" value={subagentTemplateDraft.description} onChange={value => setSubagentTemplateDraft(current => ({ ...current, description: value }))} placeholder={t("subagentTemplateDescriptionPlaceholder")} />
              <label className="settings-form-label" htmlFor="subagent-template-prompt">{t("subagentTemplateInstructions")}</label>
              <textarea id="subagent-template-prompt" className="settings-textarea" rows={5} value={subagentTemplateDraft.systemPrompt} onChange={event => setSubagentTemplateDraft(current => ({ ...current, systemPrompt: event.target.value }))} placeholder={t("subagentTemplateInstructionsPlaceholder")} />
              <label className="settings-form-label" htmlFor="subagent-template-model">模型（留空使用当前模型）</label>
              <Select
                items={["使用当前上下文模型", ...llmModels.map(profile => `${profile.name} (${profile.model})`)]}
                defaultIndex={Math.max(0, subagentTemplateDraft.modelProfileId
                  ? llmModels.findIndex(profile => profile.id === subagentTemplateDraft.modelProfileId) + 1
                  : 0)}
                onSelectedItemChange={changes => {
                  const selected = llmModels.find(profile => `${profile.name} (${profile.model})` === changes.selectedItem);
                  setSubagentTemplateDraft(current => ({ ...current, modelProfileId: selected?.id || "" }));
                }}
              />
              <div className="settings-form-label">{t("subagentAllowedBuiltinDomains")}</div>
              <div className="settings-checkbox-grid">
                {Object.keys(BUILTIN_TOOL_GROUPS).map(domain => <Checkbox key={domain} isSelected={subagentTemplateDraft.allowedBuiltinDomains.includes(domain)} onChange={selected => setSubagentTemplateDraft(current => ({ ...current, allowedBuiltinDomains: selected ? [...current.allowedBuiltinDomains, domain] : current.allowedBuiltinDomains.filter(item => item !== domain) }))}><span className="text-sm">{domain}</span></Checkbox>)}
              </div>
              <div className="settings-form-label">{t("subagentAllowedMcpServers")}</div>
              <div className="settings-checkbox-grid">
                {mcpServerOptions.length === 0 ? <span className="settings-api-url-hint">{t("subagentNoConnectedMcpServers")}</span> : mcpServerOptions.map(server => <Checkbox key={server} isSelected={subagentTemplateDraft.allowedMcpServers.includes(server)} onChange={selected => setSubagentTemplateDraft(current => ({ ...current, allowedMcpServers: selected ? [...current.allowedMcpServers, server] : current.allowedMcpServers.filter(item => item !== server) }))}><span className="text-sm">{server}</span></Checkbox>)}
              </div>
              <Checkbox isSelected={subagentTemplateDraft.enabled} onChange={selected => setSubagentTemplateDraft(current => ({ ...current, enabled: selected }))}><span className="text-sm">{t("subagentEnableTemplate")}</span></Checkbox>
              <Button className="settings-model-add-button bg-[var(--w-indigo)]" onPress={saveSubagentTemplateDraft}>{editingSubagentTemplateId ? t("subagentSaveTemplate") : t("subagentSubmitTemplate")}</Button>
            </div>
          )}
        </div>

        <div className="settings-card">
          <div className="settings-card-title">快捷入口</div>
          <div className="settings-tab-action-row">
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleScreenshotCurrentPage}
            >
              screenshot
            </Button>
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleOpenPlayground}
            >
              playground
            </Button>
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleOpenStash}
            >
              stash
            </Button>
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleOpenPostdog}
            >
              postdog
            </Button>
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleOpenHooks}
            >
              hooks
            </Button>
          </div>
          <hr className="settings-quick-entry-divider" />
          <div className="settings-card-title settings-card-title-inline">高级功能</div>
          <div className="settings-tab-action-row settings-tab-action-row-secondary">
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleOpenAdvancedUsage}
            >
              高级用法
            </Button>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">配置备份</div>
          <div className="settings-tab-action-row">
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleExportSettings}
              isDisabled={loading || saving}
            >
              导出配置
            </Button>
            <Button
              className="!min-h-7 !px-3 !py-0 !text-xs"
              onPress={handleImportSettingsClick}
              isDisabled={loading || saving}
            >
              导入配置
            </Button>
            <input
              ref={settingsImportInputRef}
              type="file"
              accept="application/json,.json"
              className="settings-hidden-file-input"
              onChange={handleImportSettingsFile}
            />
          </div>
          <div className="settings-api-url-hint !text-red-600">
            只有保存后才能导出；导出包含 API Key，且不会导出 WS Bridge 相关配置；导入只更新文件中存在的配置项。
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">{t("supabaseStorageSync")}</div>
          <Input
            label={t("supabaseProjectUrl")}
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={supabaseUrl}
            onChange={setSupabaseUrl}
            placeholder="https://your-project.supabase.co"
          />
          <Input
            label={t("supabaseBucket")}
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={supabaseBucket}
            onChange={setSupabaseBucket}
            placeholder="TABPILOT"
          />
          <Input
            label={t("supabaseRootDirectory")}
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={supabaseBasePath}
            onChange={setSupabaseBasePath}
            placeholder="tabmanager"
          />
          <div className="settings-secret-field">
            <label className="!text-sm !font-medium !text-gray-500" htmlFor="settings-supabase-key">{t("supabaseKey")}</label>
            <div className="settings-secret-input-wrapper">
              <input
                id="settings-supabase-key"
                className="settings-secret-input !min-h-8"
                type={showSupabaseKey ? "text" : "password"}
                value={supabaseKey}
                onChange={event => setSupabaseKey(event.target.value)}
                placeholder="Supabase anon key"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="settings-secret-toggle"
                onClick={() => setShowSupabaseKey(value => !value)}
                aria-label={showSupabaseKey ? t("hideSupabaseKey") : t("showSupabaseKey")}
                title={showSupabaseKey ? t("hideSupabaseKey") : t("showSupabaseKey")}
              >
                {showSupabaseKey ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M3 3L21 21M10.6 10.7A3 3 0 0 0 13.3 13.4M9.9 5.1A10.9 10.9 0 0 1 12 4.9C17 4.9 21 12 21 12A20.6 20.6 0 0 1 17.4 16.6M14.1 14.3A3 3 0 0 1 9.7 9.9M6.5 7.5A20.3 20.3 0 0 0 3 12S7 19.1 12 19.1C13.3 19.1 14.5 18.8 15.6 18.3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M2.5 12S6.5 5 12 5s9.5 7 9.5 7-4 7-9.5 7S2.5 12 2.5 12Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <div className="settings-api-url-hint">
            {t("supabaseHint")}
          </div>
          <div className="settings-tab-action-row">
            <Button className="!min-h-7 !px-3 !py-0 !text-xs" onPress={handleSyncSessionsWithSupabase} isDisabled={supabaseRunning || !hasUsableSupabaseConfig(currentSupabaseConfig())}>
              {supabaseRunning ? t("supabaseWorking") : t("syncSessions")}
            </Button>
            <Button className="!min-h-7 !px-3 !py-0 !text-xs !bg-yellow-100 !text-yellow-800 !border !border-yellow-300 hover:!bg-yellow-200" onPress={handleRestoreSettingsFromSupabase} isDisabled={supabaseRunning || !hasUsableSupabaseConfig(currentSupabaseConfig())}>
              {t("restoreSettingsFromSupabase")}
            </Button>
            <Button className="!min-h-7 !px-3 !py-0 !text-xs !bg-yellow-100 !text-yellow-800 !border !border-yellow-300 hover:!bg-yellow-200" onPress={handleOverwriteSupabaseSettings} isDisabled={supabaseRunning || !hasUsableSupabaseConfig(currentSupabaseConfig())}>
              {t("overwriteSupabaseSettings")}
            </Button>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">{t("feedback")}</div>
          <div className="settings-api-url-hint">{t("feedbackHint")}</div>
          <div className="settings-tab-action-row">
            <a
              href="https://github.com/sunwu51/TabPilot/issues"
              target="_blank"
              rel="noreferrer"
            >
              <Button className="!min-h-7 !px-3 !py-0 !text-xs">{t("feedback")}</Button>
            </a>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">{t("language")}</div>
          <Select
            label={t("language")}
            items={[t("chinese"), t("english")]}
            defaultIndex={locale === "zh" ? 0 : 1}
            onSelectedItemChange={(changes) => setLocale(changes.selectedItem === t("chinese") ? "zh" : "en")}
          />
          <div className="settings-api-url-hint">{t("languageHint")}</div>
        </div>

      </div>

      <div className="settings-dialog-actions">
        <span className="text-xs text-gray-400" style={{ marginRight: "auto" }}>
          版本 {chrome?.runtime?.getManifest?.()?.version || "—"}
        </span>
        <Button
          className="!text-sm !min-h-8 !px-4 !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
          onPress={handleCancel}
          isDisabled={loading || saving}
        >
          取消
        </Button>
        <Button
          className="!text-sm !min-h-8 !px-4"
          onPress={handleConfirm}
          isDisabled={loading || saving}
        >
          {saving ? "保存中..." : "确认"}
        </Button>
      </div>
    </div>
  );
}

function normalizeWsServerUrlInput(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function hasAnyTextValue(...values) {
  return values.some(value => String(value || "").trim().length > 0);
}

function buildTtsVoiceOptions(voices) {
  const availableVoices = Array.isArray(voices) ? voices : [];
  const chineseVoices = availableVoices.filter(voice => String(voice?.lang || "").toLowerCase().includes("zh"));
  const visibleVoices = chineseVoices.length > 0 ? chineseVoices : availableVoices;
  const options = visibleVoices.map(voice => {
    const name = String(voice?.name || "").trim();
    const lang = String(voice?.lang || "").trim();
    const label = [name || "未命名音色", lang].filter(Boolean).join(" · ");
    return {
      label,
      value: name
    };
  }).filter(item => item.value);
  return [
    { label: "自动选择", value: "" },
    ...options
  ];
}

function normalizeReasoningEffort(value) {
  return ["default", "low", "medium", "high", "xhigh"].includes(value) ? value : "default";
}

function createEmptySubagentTemplate() {
  return {
    templateName: "",
    description: "",
    systemPrompt: "",
    modelProfileId: "",
    allowedBuiltinDomains: [],
    allowedMcpServers: [],
    enabled: true
  };
}
