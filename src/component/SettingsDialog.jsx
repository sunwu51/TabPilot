/* global chrome */
import { Button, Checkbox, Dialog, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { resolveLlmRequestUrl } from "../api/llmEndpoint";
import { clearReuseDomainPolicies, getReuseDomainPolicies } from "../api/tabReuse";

const DEFAULT_SETTINGS = {
  llmConfig: {
    apiType: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    firstPacketTimeoutSeconds: 20,
    supportsImageInput: false
  },
  suspendTimeout: 0,
  mcpToolTimeoutSeconds: 60,
  reuse: false
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

function SettingsDialogBody() {
  const [apiType, setApiType] = useState(DEFAULT_SETTINGS.llmConfig.apiType);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SETTINGS.llmConfig.baseUrl);
  const [apiKey, setApiKey] = useState(DEFAULT_SETTINGS.llmConfig.apiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState(DEFAULT_SETTINGS.llmConfig.model);
  const [firstPacketTimeoutSeconds, setFirstPacketTimeoutSeconds] = useState(DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds);
  const [supportsImageInput, setSupportsImageInput] = useState(DEFAULT_SETTINGS.llmConfig.supportsImageInput);
  const [suspendTimeout, setSuspendTimeout] = useState(DEFAULT_SETTINGS.suspendTimeout);
  const [mcpToolTimeoutSeconds, setMcpToolTimeoutSeconds] = useState(DEFAULT_SETTINGS.mcpToolTimeoutSeconds);
  const [reuse, setReuse] = useState(DEFAULT_SETTINGS.reuse);
  const [reusePolicyCount, setReusePolicyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const rootRef = useRef(null);
  const suspendOptions = [
    { label: "关闭", value: 0 },
    { label: "15 分钟", value: 15 },
    { label: "30 分钟", value: 30 },
    { label: "1 小时", value: 60 },
    { label: "2 小时", value: 120 },
    { label: "1 天", value: 1440 }
  ];
  const resolvedApiUrl = resolveLlmRequestUrl(apiType, baseUrl);

  useEffect(() => {
    void loadDraft();
  }, []);

  async function loadDraft() {
    setLoading(true);
    try {
      const res = await chrome.storage.local.get(DEFAULT_SETTINGS);
      const nextLlmConfig = { ...DEFAULT_SETTINGS.llmConfig, ...(res.llmConfig || {}) };
      setApiType(nextLlmConfig.apiType || DEFAULT_SETTINGS.llmConfig.apiType);
      setBaseUrl(nextLlmConfig.baseUrl || "");
      setApiKey(nextLlmConfig.apiKey || "");
      setModel(nextLlmConfig.model || "");
      setFirstPacketTimeoutSeconds(Math.max(1, Number(nextLlmConfig.firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds));
      setSupportsImageInput(nextLlmConfig.supportsImageInput === true);
      setSuspendTimeout(Number(res.suspendTimeout) || 0);
      setMcpToolTimeoutSeconds(Math.max(1, Number(res.mcpToolTimeoutSeconds) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds));
      setReuse(!!res.reuse);

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
      await chrome.storage.local.set({
        llmConfig: {
          apiType,
          baseUrl,
          apiKey,
          model,
          firstPacketTimeoutSeconds: Math.max(1, Number(firstPacketTimeoutSeconds) || DEFAULT_SETTINGS.llmConfig.firstPacketTimeoutSeconds),
          supportsImageInput
        },
        suspendTimeout,
        mcpToolTimeoutSeconds: Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_SETTINGS.mcpToolTimeoutSeconds),
        reuse
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

  return (
    <div ref={rootRef} key={formKey} className="settings-dialog-body">
      <div className="settings-dialog-scroll">
      <Select
        label="API 类型"
        items={["OpenAI 兼容", "Anthropic"]}
        defaultIndex={apiType === "anthropic" ? 1 : 0}
        onSelectedItemChange={(changes) => {
          setApiType(changes.selectedItem === "Anthropic" ? "anthropic" : "openai");
        }}
      />
      <Input
        label="API 地址"
        labelClassName="!text-sm !font-medium !text-gray-500"
        inputClassName="!min-h-8"
        defaultValue={baseUrl}
        onChange={setBaseUrl}
        placeholder={apiType === "anthropic" ? "https://api.deepseek.com/anthropic/messages" : "https://api.deepseek.com/chat/completions"}
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
            placeholder={apiType === "anthropic" ? "sk-ant-..." : "sk-..."}
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
        placeholder={apiType === "anthropic" ? "claude-sonnet-4-20250514" : "deepseek-v4-flash"}
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
      <div className="mt-2">
        <Checkbox isSelected={supportsImageInput} onChange={setSupportsImageInput}>
          <span className="text-sm">模型支持图片输入（开启后允许截图工具，并把截图作为图片上下文传给模型）</span>
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
        label="自动释放长期不用标签的内存"
        items={suspendOptions.map((item) => item.label)}
        defaultIndex={Math.max(0, suspendOptions.findIndex((item) => item.value === suspendTimeout))}
        onSelectedItemChange={(changes) => {
          const selected = suspendOptions.find((item) => item.label === changes.selectedItem);
          setSuspendTimeout(selected ? selected.value : 0);
        }}
      />
      <div className="mt-2">
        <Checkbox isSelected={reuse} onChange={setReuse}>
          <span className="text-sm">复用 Tab（命中已存在页面时优先询问是否复用，并可记住域名选择）</span>
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
      </div>
      <div className="settings-dialog-actions">
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
