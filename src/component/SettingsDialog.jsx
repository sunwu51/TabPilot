/* global chrome */
import { Button, Checkbox, Dialog, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { resolveLlmRequestUrl } from "../api/llmEndpoint";
import {
  API_TYPES,
  DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
  MODEL_CONTEXT_LIMIT_OPTIONS,
  getDefaultApiType,
  normalizeApiType,
  normalizeModelContextLimitTokens
} from "../api/llm";
import { captureFullPageScreenshotToTab, openHelloWorldPlayground } from "../api/llm/builtins";
import {
  downloadSettingsBackup,
  exportSettingsBackup,
  importSettingsBackupFromText
} from "../api/settingsBackup";
import { clearReuseDomainPolicies, getReuseDomainPolicies } from "../api/tabReuse";
import {
  DEFAULT_WS_BRIDGE_STATUS,
  formatWsBridgeStatusTime,
  getWsBridgeStateMeta,
  WS_BRIDGE_STATUS_STORAGE_KEY
} from "../api/wsBridgeShared";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_API_PROTOCOLS,
  normalizeImageApiProtocol,
  resolveImageApiRequestUrl
} from "../api/llm/builtins/imageApi";

const DEFAULT_SETTINGS = {
  llmConfig: {
    apiType: getDefaultApiType(),
    baseUrl: "",
    apiKey: "",
    model: "",
    modelContextLimitTokens: DEFAULT_MODEL_CONTEXT_LIMIT_TOKENS,
    firstPacketTimeoutSeconds: 20,
    supportsImageInput: false,
    reasoningEffort: "default",
    omitThinkingFromRequests: false,
    imageBaseUrl: "",
    imageApiKey: "",
    imageApiProtocol: IMAGE_API_PROTOCOLS.GENERATE,
    imageModel: DEFAULT_IMAGE_MODEL
  },
  mcpToolTimeoutSeconds: 60,
  reuse: false,
  extractTextLimit: 8000,
  betaFeaturesEnabled: true,
  bridgeEnabled: false,
  wsServerUrl: "",
  hideCopyButton: false,
  dangerousToolSkipApproval: false
};

/**
 * Settings dialog for LLM API configuration, tab reuse, and auto-suspend.
 * Draft values are only persisted when the user confirms.
 */
export default function SettingsDialog() {
  return (
    <Dialog trigger={<Button className="w-16">设置</Button>}>
      <SettingsDialogBody />
    </Dialog>
  );
}

const ADVANCED_USAGE_URL = "https://my.feishu.cn/wiki/EyDcwiBaliWlDNkRVv0cOAVHnUd?from=from_copylink";

function SettingsDialogBody() {
  const [apiType, setApiType] = useState(DEFAULT_SETTINGS.llmConfig.apiType);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SETTINGS.llmConfig.baseUrl);
  const [apiKey, setApiKey] = useState(DEFAULT_SETTINGS.llmConfig.apiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showImageApiKey, setShowImageApiKey] = useState(false);
  const [model, setModel] = useState(DEFAULT_SETTINGS.llmConfig.model);
  const [modelContextLimitTokens, setModelContextLimitTokens] = useState(DEFAULT_SETTINGS.llmConfig.modelContextLimitTokens);
  const [firstPacketTimeoutSeconds, setFirstPacketTimeoutSeconds] = useState(DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds);
  const [supportsImageInput, setSupportsImageInput] = useState(DEFAULT_SETTINGS.llmConfig.supportsImageInput);
  const [reasoningEffort, setReasoningEffort] = useState(DEFAULT_SETTINGS.llmConfig.reasoningEffort);
  const [omitThinkingFromRequests, setOmitThinkingFromRequests] = useState(DEFAULT_SETTINGS.llmConfig.omitThinkingFromRequests);
  const [imageBaseUrl, setImageBaseUrl] = useState(DEFAULT_SETTINGS.llmConfig.imageBaseUrl);
  const [imageApiKey, setImageApiKey] = useState(DEFAULT_SETTINGS.llmConfig.imageApiKey);
  const [imageApiProtocol, setImageApiProtocol] = useState(DEFAULT_SETTINGS.llmConfig.imageApiProtocol);
  const [imageModel, setImageModel] = useState(DEFAULT_SETTINGS.llmConfig.imageModel);
  const [mcpToolTimeoutSeconds, setMcpToolTimeoutSeconds] = useState(DEFAULT_SETTINGS.mcpToolTimeoutSeconds);
  const [reuse, setReuse] = useState(DEFAULT_SETTINGS.reuse);
  const [extractTextLimit, setExtractTextLimit] = useState(DEFAULT_SETTINGS.extractTextLimit);
  const [betaFeaturesEnabled, setBetaFeaturesEnabled] = useState(DEFAULT_SETTINGS.betaFeaturesEnabled);
  const [bridgeEnabled, setBridgeEnabled] = useState(DEFAULT_SETTINGS.bridgeEnabled);
  const [wsServerUrl, setWsServerUrl] = useState(DEFAULT_SETTINGS.wsServerUrl);
  const [hideCopyButton, setHideCopyButton] = useState(DEFAULT_SETTINGS.hideCopyButton);
  const [dangerousToolSkipApproval, setDangerousToolSkipApproval] = useState(DEFAULT_SETTINGS.dangerousToolSkipApproval);
  const [wsBridgeStatus, setWsBridgeStatus] = useState(DEFAULT_WS_BRIDGE_STATUS);
  const [reusePolicyCount, setReusePolicyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const rootRef = useRef(null);
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

  useEffect(() => {
    void loadDraft();
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
      const res = await chrome.storage.local.get({
        ...DEFAULT_SETTINGS,
        [WS_BRIDGE_STATUS_STORAGE_KEY]: DEFAULT_WS_BRIDGE_STATUS
      });
      const nextLlmConfig = { ...DEFAULT_SETTINGS.llmConfig, ...(res.llmConfig || {}) };
      setApiType(normalizeApiType(nextLlmConfig.apiType || DEFAULT_SETTINGS.llmConfig.apiType));
      setBaseUrl(nextLlmConfig.baseUrl || "");
      setApiKey(nextLlmConfig.apiKey || "");
      setModel(nextLlmConfig.model || "");
      setModelContextLimitTokens(normalizeModelContextLimitTokens(nextLlmConfig.modelContextLimitTokens));
      setFirstPacketTimeoutSeconds(Math.max(1, Number(nextLlmConfig.firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds));
      setSupportsImageInput(nextLlmConfig.supportsImageInput === true);
      setReasoningEffort(normalizeReasoningEffort(nextLlmConfig.reasoningEffort));
      setOmitThinkingFromRequests(nextLlmConfig.omitThinkingFromRequests === true);
      setImageBaseUrl(nextLlmConfig.imageBaseUrl || "");
      setImageApiKey(nextLlmConfig.imageApiKey || "");
      setImageApiProtocol(normalizeImageApiProtocol(nextLlmConfig.imageApiProtocol));
      setImageModel(nextLlmConfig.imageModel || DEFAULT_IMAGE_MODEL);
      setMcpToolTimeoutSeconds(Math.max(1, Number(res.mcpToolTimeoutSeconds) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds));
      setReuse(!!res.reuse);
      setExtractTextLimit(res.extractTextLimit || DEFAULT_SETTINGS.extractTextLimit);
      setBetaFeaturesEnabled(res.betaFeaturesEnabled !== false);
      setBridgeEnabled(!!res.bridgeEnabled);
      setWsServerUrl(typeof res.wsServerUrl === "string" ? res.wsServerUrl : "");
      setHideCopyButton(!!res.hideCopyButton);
      setDangerousToolSkipApproval(!!res.dangerousToolSkipApproval);
      setWsBridgeStatus({
        ...DEFAULT_WS_BRIDGE_STATUS,
        ...(res[WS_BRIDGE_STATUS_STORAGE_KEY] || {})
      });

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
    setSaving(true);
    try {
      const normalizedWsServerUrl = normalizeWsServerUrlInput(wsServerUrl);
      if (bridgeEnabled && !normalizedWsServerUrl) {
        toast.error("WS Server 地址必须是合法的 ws:// 或 wss:// URL");
        return;
      }

      await chrome.storage.local.set({
        llmConfig: {
          apiType,
          baseUrl,
          apiKey,
          model,
          modelContextLimitTokens: normalizeModelContextLimitTokens(modelContextLimitTokens),
          firstPacketTimeoutSeconds: Math.max(1, Number(firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds),
          supportsImageInput,
          reasoningEffort: normalizeReasoningEffort(reasoningEffort),
          omitThinkingFromRequests,
          imageBaseUrl,
          imageApiKey,
          imageApiProtocol: normalizeImageApiProtocol(imageApiProtocol),
          imageModel: imageModel || DEFAULT_IMAGE_MODEL
        },
        mcpToolTimeoutSeconds: Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds),
        reuse,
        extractTextLimit,
        betaFeaturesEnabled,
        bridgeEnabled,
        wsServerUrl: bridgeEnabled ? normalizedWsServerUrl : null,
        hideCopyButton,
        dangerousToolSkipApproval
      });
      toast.success("设置已保存");
      closeDialog();
    } catch (error) {
      toast.error(`保存失败: ${error?.message || String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    void loadDraft();
    closeDialog();
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
    <div ref={rootRef} key={formKey} className="settings-dialog-body">
      <div className="settings-dialog-scroll">
        <div className="settings-card">
          <div className="settings-card-title">LLM 配置</div>
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
            最终 URL 为 {resolvedApiUrl || "—"}
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
            <Checkbox isSelected={supportsImageInput} onChange={setSupportsImageInput}>
              <span className="text-sm">模型支持图片输入</span>
            </Checkbox>
          </div>
          <div className="settings-inline-section-title">Image API 配置</div>
          <Input
            label="Image API 地址"
            labelClassName="!text-sm !font-medium !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={imageBaseUrl}
            onChange={setImageBaseUrl}
            placeholder="https://api.openai.com/v1"
          />
          <Select
            label="Image API 规范"
            items={imageProtocolOptions.map((item) => item.label)}
            defaultIndex={Math.max(0, imageProtocolOptions.findIndex((item) => item.value === imageApiProtocol))}
            onSelectedItemChange={(changes) => {
              const selected = imageProtocolOptions.find((item) => item.label === changes.selectedItem);
              setImageApiProtocol(selected ? selected.value : DEFAULT_SETTINGS.llmConfig.imageApiProtocol);
            }}
          />
          <div className="settings-api-url-hint">
            {imageApiProtocol === IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS
              ? `Chat Completions ${resolvedImageChatUrl || "—"}`
              : `生成 ${resolvedImageGenUrl || "—"}；编辑 ${resolvedImageEditUrl || "—"}`}
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
          <div className="settings-api-url-hint">
            配置完整后会向模型开放 image_gen 和 image_edit 内置工具；Chat Completions 规范不支持 mask；工具结果只在本地预览/缓存图片。
          </div>
          <div className="mt-2">
            <Checkbox isSelected={hideCopyButton} onChange={setHideCopyButton}>
              <span className="text-sm">隐藏助手消息的复制按钮</span>
            </Checkbox>
          </div>
          <div className="mt-2">
            <Checkbox isSelected={dangerousToolSkipApproval} onChange={setDangerousToolSkipApproval}>
              <span className="text-sm text-red-600">危险工具无需审批（危险）</span>
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
            <span className="text-xs text-gray-500">已记住 {reusePolicyCount} 个域名的复用决策</span>
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
            label="WS Server 地址（开启后用于自动连接与重连）"
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
          </div>
          <hr className="settings-quick-entry-divider" />
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

function normalizeReasoningEffort(value) {
  return ["default", "low", "medium", "high", "xhigh"].includes(value) ? value : "default";
}
