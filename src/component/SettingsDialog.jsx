/* global chrome */
import { Button, Checkbox, Dialog, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { resolveLlmRequestUrl } from "../api/llm/core/endpoint";
import {
  API_TYPES,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
  IMAGE_API_PROTOCOLS,
  MODEL_CONTEXT_LIMIT_OPTIONS,
  captureFullPageScreenshotToTab,
  createModelProfileId,
  createImageModelProfileId,
  getDefaultApiType,
  isBuiltinLlmModelProfileId,
  normalizeApiType,
  normalizeImageModelProfiles,
  normalizeImageApiProtocol,
  normalizeLlmModelProfiles,
  normalizeModelContextLimitTokens,
  normalizeStoredModelConfig,
  openHelloWorldPlayground,
  initializePageAgent,
  resolveImageApiRequestUrl
} from "../api/llm";
import {
  downloadSettingsBackup,
  exportSettingsBackup,
  importSettingsBackupFromText
} from "../api/settings/backup";
import { ensureSettingsMigrated } from "../api/settings/migrations";
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
  pageAgentToolsEnabled: true
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
  const [llmModelFormOpen, setLlmModelFormOpen] = useState(false);
  const [modelContextLimitTokens, setModelContextLimitTokens] = useState(DEFAULT_SETTINGS.llmConfig.modelContextLimitTokens);
  const [firstPacketTimeoutSeconds, setFirstPacketTimeoutSeconds] = useState(DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds);
  const [supportsImageInput, setSupportsImageInput] = useState(DEFAULT_SETTINGS.llmConfig.supportsImageInput);
  const [supportsToolImageInput, setSupportsToolImageInput] = useState(DEFAULT_SETTINGS.llmConfig.supportsToolImageInput);
  const [reasoningEffort, setReasoningEffort] = useState(DEFAULT_SETTINGS.llmConfig.reasoningEffort);
  const [omitThinkingFromRequests, setOmitThinkingFromRequests] = useState(DEFAULT_SETTINGS.llmConfig.omitThinkingFromRequests);
  const [imageBaseUrl, setImageBaseUrl] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageBaseUrl);
  const [imageApiKey, setImageApiKey] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageApiKey);
  const [imageApiProtocol, setImageApiProtocol] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL_DRAFT.imageModel);
  const [imageModels, setImageModels] = useState(DEFAULT_SETTINGS.llmConfig.imageModels);
  const [activeImageModelId, setActiveImageModelId] = useState(DEFAULT_SETTINGS.llmConfig.activeImageModelId);
  const [imageModelFormOpen, setImageModelFormOpen] = useState(false);
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
  const [pageAgentToolsEnabled, setPageAgentToolsEnabled] = useState(DEFAULT_SETTINGS.pageAgentToolsEnabled);
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
  const rootRef = useRef(null);
  const localizedRootRef = useLocalizedDom();
  const settingsImportInputRef = useRef(null);
  const extractTextLimitOptions = [
    { label: "8k", value: 8000 },
    { label: "16k", value: 16000 },
    { label: "32k", value: 32000 },
    { label: "128k", value: 128000 }
  ];
  const reasoningEffortOptions = [
    { label: "供应商默认", value: "default" },
    { label: "低 low", value: "low" },
    { label: "中 medium", value: "medium" },
    { label: "高 high", value: "high" },
    { label: "超高 xhigh", value: "xhigh" }
  ];
  const resolvedApiUrl = resolveLlmRequestUrl(apiType, baseUrl);
  const resolvedImageGenUrl = resolveImageApiRequestUrl(imageBaseUrl, "generations");
  const resolvedImageEditUrl = resolveImageApiRequestUrl(imageBaseUrl, "edits");
  const resolvedImageChatUrl = resolveImageApiRequestUrl(imageBaseUrl, "chat_completions");
  const imageProtocolOptions = [
    { label: "Generate / Edit API", value: IMAGE_API_PROTOCOLS.GENERATE },
    { label: "Chat Completions", value: IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS }
  ];
  const ttsVoiceOptions = buildTtsVoiceOptions(ttsVoices);

  useEffect(() => {
    void loadDraft();
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
      setImageModels(normalizedImageProfiles.profiles);
      setActiveImageModelId(normalizedImageProfiles.activeId);
      setApiType(DEFAULT_LLM_MODEL_DRAFT.apiType);
      setBaseUrl("");
      setApiKey("");
      setModel("");
      setModelContextLimitTokens(normalizeModelContextLimitTokens(nextLlmConfig.modelContextLimitTokens));
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
      setLlmModelFormOpen(false);
      setImageModelFormOpen(false);
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
      setPageAgentToolsEnabled(res.pageAgentToolsEnabled !== false);
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
    if (hasPendingModelDraft()) {
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

      const nextLlmConfig = normalizeStoredModelConfig({
          activeLlmModelId,
          llmModels,
          modelContextLimitTokens: normalizeModelContextLimitTokens(modelContextLimitTokens),
          firstPacketTimeoutSeconds: Math.max(1, Number(firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds),
          supportsImageInput,
          supportsToolImageInput: supportsImageInput && supportsToolImageInput,
          reasoningEffort: normalizeReasoningEffort(reasoningEffort),
          omitThinkingFromRequests,
          imageApiProtocol: normalizeImageApiProtocol(imageApiProtocol),
          activeImageModelId,
          imageModels
      });

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
        pageAgentToolsEnabled
      });
      await saveSupabaseConfig(currentSupabaseConfig());
      toast.success(t("settingsSaved"));
      closeDialog();
    } catch (error) {
      toast.error(`保存失败: ${error?.message || String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  function hasPendingModelDraft() {
    return hasPendingLlmModelDraft() || hasPendingImageModelDraft();
  }

  function hasPendingLlmModelDraft() {
    return llmModelFormOpen && hasAnyTextValue(baseUrl, apiKey, model);
  }

  function hasPendingImageModelDraft() {
    return imageModelFormOpen && hasAnyTextValue(imageBaseUrl, imageApiKey, imageModel);
  }

  function buildPendingModelDraftMessage() {
    const draftNames = [];
    if (hasPendingLlmModelDraft()) draftNames.push("LLM 模型");
    if (hasPendingImageModelDraft()) draftNames.push("图片模型");
    return `有未保存的${draftNames.join("和")}草稿，确认要放弃这些草稿并保存其它设置吗？`;
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
      if (nextOpen) {
        const activeProfile = imageModels.find(item => item.id === activeImageModelId);
        if (activeProfile) {
          setImageBaseUrl(activeProfile.imageBaseUrl || "");
          setImageApiKey(activeProfile.imageApiKey || "");
          setImageApiProtocol(normalizeImageApiProtocol(activeProfile.imageApiProtocol));
          setImageModel(activeProfile.imageModel || "");
        }
      }
      return nextOpen;
    });
  }

  async function handleAddLlmModel() {
    const trimmedBaseUrl = String(baseUrl || "").trim();
    const trimmedApiKey = String(apiKey || "").trim();
    const trimmedModel = String(model || "").trim();
    if (!trimmedBaseUrl || !trimmedApiKey || !trimmedModel) {
      toast.error("API 地址、API Key 和模型不能为空");
      return;
    }
    const profile = {
      id: createModelProfileId("llm"),
      name: trimmedModel,
      apiType: normalizeApiType(apiType),
      baseUrl: trimmedBaseUrl,
      apiKey: trimmedApiKey,
      model: trimmedModel,
      nativeWebSearch: normalizeApiType(apiType) === API_TYPES.OPENAI_RESPONSES && nativeWebSearch
    };
    try {
      const res = await chrome.storage.local.get({ llmConfig: DEFAULT_SETTINGS.llmConfig });
      const rawStoredConfig = res.llmConfig || {};
      const storedConfig = { ...DEFAULT_SETTINGS.llmConfig, ...rawStoredConfig };
      const storedProfiles = normalizeLlmModelProfiles(rawStoredConfig);
      const nextModels = [...storedProfiles.profiles, profile];
      const nextActiveLlmModelId = storedProfiles.activeId || profile.id;
      const nextLlmConfig = normalizeStoredModelConfig({
        ...storedConfig,
        llmModels: nextModels,
        activeLlmModelId: nextActiveLlmModelId
      });
      await chrome.storage.local.set({ llmConfig: nextLlmConfig });
      setLlmModels(prev => [...prev, profile]);
      if (!activeLlmModelId) setActiveLlmModelId(profile.id);
      toast.success("模型已添加");
    } catch (error) {
      toast.error(`添加模型失败: ${error?.message || String(error)}`);
      return;
    }
    setApiType(DEFAULT_LLM_MODEL_DRAFT.apiType);
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setNativeWebSearch(false);
    setLlmModelFormOpen(false);
    setFormKey(prev => prev + 1);
  }

  function handleRemoveLlmModel(id) {
    if (isBuiltinLlmModelProfileId(id)) return;
    setLlmModels(prev => {
      const next = prev.filter(item => item.id !== id);
      if (activeLlmModelId === id) {
        setActiveLlmModelId(next[0]?.id || "");
      }
      return next;
    });
  }

  async function handleAddImageModel() {
    const trimmedBaseUrl = String(imageBaseUrl || "").trim();
    const trimmedApiKey = String(imageApiKey || "").trim();
    const trimmedModel = String(imageModel || "").trim();
    if (!trimmedBaseUrl || !trimmedApiKey || !trimmedModel) {
      toast.error("Image API 地址、Token 和模型不能为空");
      return;
    }
    const profile = {
      id: createImageModelProfileId(trimmedModel),
      name: trimmedModel,
      imageBaseUrl: trimmedBaseUrl,
      imageApiKey: trimmedApiKey,
      imageApiProtocol: normalizeImageApiProtocol(imageApiProtocol),
      imageModel: trimmedModel
    };
    try {
      const res = await chrome.storage.local.get({ llmConfig: DEFAULT_SETTINGS.llmConfig });
      const rawStoredConfig = res.llmConfig || {};
      const storedConfig = { ...DEFAULT_SETTINGS.llmConfig, ...rawStoredConfig };
      const storedProfiles = normalizeImageModelProfiles(rawStoredConfig);
      const nextModels = [...storedProfiles.profiles, profile];
      const nextActiveImageModelId = storedProfiles.activeId || profile.id;
      const nextLlmConfig = normalizeStoredModelConfig({
        ...storedConfig,
        imageModels: nextModels,
        activeImageModelId: nextActiveImageModelId
      });
      await chrome.storage.local.set({ llmConfig: nextLlmConfig });
      setImageModels(prev => [...prev, profile]);
      if (!activeImageModelId) setActiveImageModelId(profile.id);
      toast.success("图片模型已添加");
    } catch (error) {
      toast.error(`添加图片模型失败: ${error?.message || String(error)}`);
      return;
    }
    setImageBaseUrl("");
    setImageApiKey("");
    setImageApiProtocol(DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol);
    setImageModel("");
    setImageModelFormOpen(false);
    setFormKey(prev => prev + 1);
  }

  function handleRemoveImageModel(id) {
    setImageModels(prev => {
      const next = prev.filter(item => item.id !== id);
      if (activeImageModelId === id) {
        setActiveImageModelId(next[0]?.id || "");
      }
      return next;
    });
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

  async function handleInitializePageAgent() {
    const toastId = toast.loading("正在注入 Page Agent...");
    const result = await initializePageAgent();
    toast.dismiss(toastId);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    toast.success("Page Agent 已注入当前页面");
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
          <div className="settings-card-title">{t("language")}</div>
          <Select
            label={t("language")}
            items={[t("chinese"), t("english")]}
            defaultIndex={locale === "zh" ? 0 : 1}
            onSelectedItemChange={(changes) => setLocale(changes.selectedItem === t("chinese") ? "zh" : "en")}
          />
          <div className="settings-api-url-hint">{t("languageHint")}</div>
        </div>
        <div className="settings-card">
          <div className="settings-card-title">LLM 配置</div>
          <div className="settings-model-badges" aria-label="已保存 LLM 模型">
            {llmModels.length === 0 ? (
              <span className="settings-model-empty">暂无模型</span>
            ) : llmModels.map(item => (
              <button
                key={item.id}
                type="button"
                className={`settings-model-badge${item.id === activeLlmModelId ? " settings-model-badge-active" : ""}`}
                onClick={() => setActiveLlmModelId(item.id)}
                title={`${item.name}\n${item.apiType}\n${item.baseUrl}`}
              >
                <span className="settings-model-badge-name">{item.name}</span>
                {!isBuiltinLlmModelProfileId(item.id) && (
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
                )}
              </button>
            ))}
          </div>
          <Button
            className="settings-model-add-toggle bg-[var(--w-indigo)]"
            onPress={handleToggleLlmModelForm}
          >
            {llmModelFormOpen ? "收起添加模型" : "添加模型"}
          </Button>
          {llmModelFormOpen && (
            <div className="settings-model-form">
              <Select
                label="API 类型"
                items={["OpenAI Chat Completions", "OpenAI Responses", "Anthropic"]}
                defaultIndex={apiType === API_TYPES.OPENAI_RESPONSES ? 1 : (apiType === API_TYPES.ANTHROPIC ? 2 : 0)}
                onSelectedItemChange={(changes) => {
                  const selected = changes.selectedItem;
                  if (selected === "Anthropic") {
                    setApiType(API_TYPES.ANTHROPIC);
                  } else if (selected === "OpenAI Responses") {
                    setApiType(API_TYPES.OPENAI_RESPONSES);
                  } else {
                    setApiType(API_TYPES.OPENAI_CHAT_COMPLETIONS);
                  }
                }}
              />
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
              <Input
                label="模型"
                labelClassName="!text-sm !font-medium !text-gray-500"
                inputClassName="!min-h-8"
                defaultValue={model}
                onChange={setModel}
                placeholder={apiType === API_TYPES.ANTHROPIC ? "claude-sonnet-4-20250514" : (apiType === API_TYPES.OPENAI_RESPONSES ? "gpt-4.1-mini" : "deepseek-v4-flash")}
              />
              {apiType === API_TYPES.OPENAI_RESPONSES && (
                <Checkbox isSelected={nativeWebSearch} onChange={setNativeWebSearch}>
                  <span className="text-sm">启用 OpenAI 服务端联网搜索</span>
                </Checkbox>
              )}
              <Button className="settings-model-add-button bg-[var(--w-indigo)]" onPress={handleAddLlmModel}>
                添加
              </Button>
            </div>
          )}
          <Select
            label="模型上下文大小（用于上下文告警）"
            items={MODEL_CONTEXT_LIMIT_OPTIONS.map((item) => item.label)}
            defaultIndex={Math.max(0, MODEL_CONTEXT_LIMIT_OPTIONS.findIndex((item) => item.value === modelContextLimitTokens))}
            onSelectedItemChange={(changes) => {
              const selected = MODEL_CONTEXT_LIMIT_OPTIONS.find((item) => item.label === changes.selectedItem);
              setModelContextLimitTokens(selected ? selected.value : DEFAULT_SETTINGS.llmConfig.modelContextLimitTokens);
            }}
          />
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
          <Select
            label="思考强度"
            items={reasoningEffortOptions.map((item) => item.label)}
            defaultIndex={Math.max(0, reasoningEffortOptions.findIndex((item) => item.value === reasoningEffort))}
            onSelectedItemChange={(changes) => {
              const selected = reasoningEffortOptions.find((item) => item.label === changes.selectedItem);
              setReasoningEffort(selected ? selected.value : DEFAULT_SETTINGS.llmConfig.reasoningEffort);
            }}
          />
          <div className="settings-api-url-hint">
            默认不设置，由供应商决定
          </div>
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
                className={`settings-model-badge settings-image-model-badge${item.id === activeImageModelId ? " settings-model-badge-active" : ""}`}
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
              </button>
            ))}
          </div>
          <Button
            className="settings-model-add-toggle bg-[var(--w-green)]"
            onPress={handleToggleImageModelForm}
          >
            {imageModelFormOpen ? "收起添加图片模型" : "添加图片模型"}
          </Button>
          {imageModelFormOpen && (
            <div className="settings-model-form">
              <Select
                label="Image API 规范"
                items={imageProtocolOptions.map((item) => item.label)}
                defaultIndex={Math.max(0, imageProtocolOptions.findIndex((item) => item.value === imageApiProtocol))}
                onSelectedItemChange={(changes) => {
                  const selected = imageProtocolOptions.find((item) => item.label === changes.selectedItem);
                  setImageApiProtocol(selected ? selected.value : DEFAULT_IMAGE_MODEL_DRAFT.imageApiProtocol);
                }}
              />
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
              <Button className="settings-model-add-button bg-[var(--w-green)]" onPress={handleAddImageModel}>
                添加
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
          <div className="mt-2">
            <Checkbox isSelected={pageAgentToolsEnabled} onChange={setPageAgentToolsEnabled}>
              <span className="text-sm">开启 Page Agent 工具</span>
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
              onPress={handleInitializePageAgent}
            >
              page agent
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
