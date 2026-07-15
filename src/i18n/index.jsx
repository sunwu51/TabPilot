/* global chrome */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

const LOCALE_STORAGE_KEY = "uiLocale";
const LocaleContext = createContext(null);

const MESSAGES = {
  zh: {
    tabManagement: "标签管理",
    assistant: "小助手",
    toolBridge: "工具透出",
    settings: "设置",
    newSession: "新建",
    newConversation: "新会话",
    systemPrompt: "系统",
    clear: "清空",
    export: "导出",
    schedule: "调度",
    history: "历史",
    context: "上下文",
    send: "发送",
    stop: "停止",
    modelOutput: "模型正在输出... (Enter 加入队列, Shift+Enter 换行)",
    messagePlaceholder: "输入消息... (Enter 发送, Shift+Enter 换行；{shortcut} 搜索)",
    imageAttachment: "图片",
    textFileAttachment: "文本文件",
    connect: "连接",
    disconnect: "断开",
    settingsSaved: "设置已保存",
    language: "语言",
    chinese: "中文",
    english: "English",
    languageHint: "默认根据浏览器语言选择；保存后使用手动选择。"
  },
  en: {
    tabManagement: "TabPilot",
    assistant: "Assistant",
    toolBridge: "Tool Bridge",
    settings: "Settings",
    newSession: "New",
    newConversation: "New conversation",
    systemPrompt: "System",
    clear: "Clear",
    export: "Export",
    schedule: "Schedule",
    history: "History",
    context: "Context",
    send: "Send",
    stop: "Stop",
    modelOutput: "Model is responding... (Enter to queue, Shift+Enter for newline)",
    messagePlaceholder: "Enter a message... (Enter to send, Shift+Enter for newline; {shortcut} to search)",
    imageAttachment: "Image",
    textFileAttachment: "Text file",
    connect: "Connect",
    disconnect: "Disconnect",
    settingsSaved: "Settings saved",
    language: "Language",
    chinese: "Chinese",
    english: "English",
    languageHint: "Defaults to your browser language until you choose a language."
  }
};

const UI_TEXT = {
  "LLM 配置": "LLM Configuration",
  "标签管理": "Tab Management",
  "工具透出": "Tool Bridge",
  "快捷入口": "Quick Access",
  "语言": "Language",
  "中文": "Chinese",
  "设置": "Settings",
  "添加模型": "Add Model",
  "收起添加模型": "Hide Add Model",
  "添加图片模型": "Add Image Model",
  "收起添加图片模型": "Hide Add Image Model",
  "暂无模型": "No models configured",
  "暂无图片模型": "No image models configured",
  "删除": "Delete",
  "添加": "Add",
  "保存": "Save",
  "取消": "Cancel",
  "确认": "Confirm",
  "API 地址": "API URL",
  "模型": "Model",
  "API 类型": "API Type",
  "模型上下文大小（用于上下文告警）": "Model context limit (for context warnings)",
  "LLM 首包超时（秒）": "LLM first-packet timeout (seconds)",
  "思考强度": "Reasoning effort",
  "默认不设置，由供应商决定": "Not set by default; determined by the provider.",
  "思考内容不回传（需供应商支持）": "Do not send reasoning content back (provider support required)",
  "MCP 工具超时（秒）": "MCP tool timeout (seconds)",
  "页面内容读取的最大长度": "Maximum page content length",
  "模型支持用户图片输入": "Model supports user image input",
  "模型支持工具图片输入": "Model supports tool image input",
  "需要先开启用户图片输入。": "Enable user image input first.",
  "Image API 配置": "Image API Configuration",
  "Image API 规范": "Image API protocol",
  "Image API 地址": "Image API URL",
  "隐藏助手消息的操作按钮（复制 / 播报）": "Hide assistant message actions (copy / speak)",
  "助手消息播报音色": "Assistant voice",
  "使用浏览器内置语音合成；不同系统和浏览器可用音色不同。": "Uses browser speech synthesis; available voices vary by system and browser.",
  "危险工具无需审批（危险）": "Skip approval for dangerous tools (unsafe)",
  "开启 Postdog 工具": "Enable Postdog tools",
  "复用 Tab": "Reuse tabs",
  "清空域名复用记忆": "Clear remembered domain reuse choices",
  "开启 Beta 功能": "Enable beta features",
  "开启工具透出": "Enable tool bridge",
  "高级功能": "Advanced",
  "高级用法": "Advanced usage",
  "配置备份": "Configuration Backup",
  "导出配置": "Export Configuration",
  "导入配置": "Import Configuration",
  "GitHub 同步": "GitHub Sync",
  "启用 GitHub 同步": "Enable GitHub Sync",
  "Repo 名称": "Repository",
  "分支": "Branch",
  "同步目录": "Sync directory",
  "同步设置": "Sync settings",
  "同步 stash": "Sync stashes",
  "同步间隔": "Sync interval",
  "保存同步配置": "Save sync configuration",
  "立即同步": "Sync now",
  "保存中...": "Saving...",
  "同步中...": "Syncing...",
  "从未": "Never",
  "版本": "Version",
  "搜索": "Search",
  "搜索标签页": "Search tabs",
  "输入关键词搜索标签页": "Enter keywords to search tabs",
  "当前": "Current",
  "其他": "Other",
  "关闭此标签页": "Close this tab",
  "分组": "Groups",
  "分组规则": "Group rule",
  "分组名#url正则": "Group name#URL regex",
  "域名分组": "Group by domain",
  "折叠所有": "Collapse all",
  "取消分组": "Ungroup",
  "工作区": "Workspaces",
  "保存当前": "Save current",
  "工作区名称": "Workspace name",
  "输入工作区名称": "Enter a workspace name",
  "暂无保存的工作区": "No saved workspaces",
  "恢复": "Restore",
  "恢复中...": "Restoring...",
  "宏": "Macros",
  "开始录制": "Start recording",
  "停止录制": "Stop recording",
  "回放": "Replay",
  "导入": "Import",
  "导出": "Export",
  "编辑": "Edit",
  "暂无宏": "No macros",
  "回放速度": "Playback speed",
  "慢速": "Slow",
  "正常": "Normal",
  "快速": "Fast",
  "极速": "Instant",
  "每步会高亮目标元素": "Highlights the target element at each step",
  "还没有宏，点上方「录制」开始": "No macros yet. Click Record above to begin.",
  "没有匹配的宏": "No matching macros",
  "录制": "Record",
  "录制中...": "Recording...",
  "在新 Tab 录制": "Record in a new tab",
  "按名称搜索": "Search by name",
  "只有保存后才能导出；导出包含 API Key，且不会导出 WS Bridge 相关配置；导入只更新文件中存在的配置项。": "Save settings before exporting. Exports include API keys but exclude WS Bridge settings; imports update only settings present in the file.",
  "Bridge 状态": "Bridge status",
  "已关闭": "Disabled",
  "已连接": "Connected",
  "连接中": "Connecting",
  "重连中": "Reconnecting",
  "已断开": "Disconnected",
  "错误": "Error",
  "未配置": "Not configured",
  "关闭": "Close",
  "清空当前会话": "Clear current session",
  "确定要清空当前会话吗？此操作会删除当前会话中的消息和计划。": "Clear this conversation? This deletes its messages and plan.",
  "确认清空": "Clear conversation",
  "暂无历史会话": "No conversation history",
  "待确认": "Awaiting approval",
  "生成中": "Generating",
  "排队中": "Queued",
  "编辑会话标题": "Edit conversation title",
  "编辑标题": "Edit title",
  "删除会话": "Delete conversation",
  "删除中": "Deleting",
  "👋 你好，我是浏览器助手": "👋 Hi, I am your browser assistant",
  "可以通过工具获取当前标签页和浏览器上下文": "I can use tools to inspect your current tabs and browser context",
  "也可以读取页面内容来回答问题": "I can also read page content to answer questions",
  "思考中": "Thinking",
  "回到底部": "Back to bottom",
  "全局搜索历史会话（Enter 搜索，Tab 切回当前）": "Search conversation history globally (Enter to search, Tab for current)",
  "当前会话搜索（Tab 切换全局）": "Search this conversation (Tab for global search)",
  "搜索中…": "Searching…",
  "当前会话": "Current conversation",
  "全局搜索": "Global search",
  "模型正在输出... (Enter 加入队列, Shift+Enter 换行)": "Model is responding... (Enter to queue, Shift+Enter for newline)",
  "输入消息... (Enter 发送, Shift+Enter 换行；": "Enter a message... (Enter to send, Shift+Enter for newline; ",
  "未配置模型": "No model configured",
  "默认图片：": "Default image: ",
  "未配置图片模型": "No image model configured",
  "图片": "Image",
  "MCP 服务器": "MCP Servers",
  "工具": "Tools",
  "惰性加载工具": "Lazy load tools",
  "功能描述": "Capability description",
  "危险工具": "Dangerous tool",
  "启用": "Enabled",
  "连接": "Connect",
  "连接中...": "Connecting...",
  "服务器名称": "Server name",
  "服务器 URL": "Server URL",
  "插件 ID": "Extension ID",
  "类型": "Type",
  "当前配置的 MCP 工具过多，可能导致调用失败，请适当调整。": "Too many MCP tools are configured; calls may fail.",
  "暂无已加载的 skill 索引": "No loaded skill index",
  "无描述": "No description",
  "已加载": "Loaded",
  "尚未加载 skills 索引": "Skills index has not been loaded",
  "skill-bridge 地址": "skill-bridge URL",
  "画像": "Profile",
  "浏览偏好画像": "Browsing preference profile",
  "分析中…": "Analyzing…",
  "↻ 立即分析": "↻ Analyze now",
  "分析近 48h 浏览记录并更新画像": "Analyze the last 48 hours of browsing history",
  "关闭画像注入": "Disable profile injection",
  "开启画像注入": "Enable profile injection",
  "已开启": "Enabled",
  "画像注入已关闭，对话不会包含画像信息。已有画像数据仍保留。": "Profile injection is disabled. Conversations will not include profile information; existing data is retained.",
  "当前画像": "Current profile",
  "暂无画像。点击「↻ 立即分析」分析近 48h 浏览记录生成（需要配置 LLM）。": "No profile yet. Click Analyze now to use the last 48 hours of browsing history (LLM configuration required).",
  "当前会话系统提示": "Current conversation system prompt",
  "默认只影响当前会话，会作为额外 system prompt 注入。": "Applies only to this conversation as additional system instructions.",
  "同时作为新会话的系统提示（最多只能有一个）": "Also use as the system prompt for new conversations (only one is allowed)",
  "导出当前会话": "Export current conversation",
  "导出文件保持原有 markdown 格式，分享链接支持可选密码。": "Exports preserve Markdown formatting; shared links support an optional password.",
  "导出中...": "Exporting...",
  "导出为文件": "Export file",
  "设置密码，留空为无密码": "Set a password (leave blank for none)",
  "分享中...": "Sharing...",
  "分享链接": "Share link",
  "分享链接有效期为 90 天。": "Shared links are valid for 90 days.",
  "显示待执行任务和最近 24 小时内的执行记录": "Shows pending jobs and execution records from the last 24 hours.",
  "刷新中...": "Refreshing...",
  "删除结束项": "Clear finished",
  "加载失败:": "Failed to load:",
  "正在加载任务…": "Loading jobs…",
  "当前没有可显示的 schedule job": "No scheduled jobs to display",
  "未命名任务": "Unnamed job",
  "预计执行时间": "Scheduled time",
  "剩余时间": "Time remaining",
  "刷新": "Refresh",
  "收起": "Collapse",
  "名称": "Name",
  "未连接": "Disconnected",
  "Headers (JSON, 可选)": "Headers (JSON, optional)",
  "惰性加载：": "Lazy loaded: ",
  "请先填写此 MCP 的功能描述": "Enter a capability description for this MCP first.",
  "加载成功后，会自动把 skill-bridge 的 MCP 工具加入当前会话。": "After loading, skill-bridge MCP tools are added to the current conversation automatically.",
  "当前会话已自动接入 skill-bridge MCP 工具，可直接调用 get_skill_detail。": "The current conversation already includes skill-bridge MCP tools and can call get_skill_detail directly.",
  "配置环境变量 `SKILLS_DIR=/path/to/skills`，启动 `npx -y mcp-skill-bridge`，输入默认地址 `http://localhost:5151/mcp`。": "Set SKILLS_DIR=/path/to/skills, start npx -y mcp-skill-bridge, then enter http://localhost:5151/mcp.",
  "skills 功能处于测试阶段，未必能达到通用 agent 中 skill 的效果。": "Skills are experimental and may differ from general agent skill behavior.",
  "当前已加载": "Currently loaded",
  "建议将 skill 数量控制在 10 个以内。": "Keep the number of skills within 10 when possible.",
  "skill-bridge 工具": "skill-bridge tools",
  "需要新增权限：浏览器下载": "Additional permission required: browser downloads",
  "授权下载权限": "Grant downloads permission",
  "危险定时任务待确认": "Dangerous scheduled task requires approval",
  "确认创建任务": "Confirm task creation",
  "危险工具待确认": "Dangerous tool requires approval",
  "确认执行": "Confirm execution",
  "危险 MCP 工具待确认": "Dangerous MCP tool requires approval",
  "需要新增权限": "Additional permission required",
  "工具需要额外的浏览器权限。": "This tool requires additional browser permissions.",
  "授权": "Grant permission",
  "执行计划待确认": "Execution plan requires approval",
  "取消标注": "Cancel annotation",
  "处理中...": "Processing..."
  ,"该功能是将浏览器操作函数作为 MCP 能力透出给其他 agent（如 Claude Code）进行使用，需配合": "This feature exposes browser operations as MCP tools for other agents (such as Claude Code). It requires the "
  ,"项目使用。": " project."
};

export function detectLocale(language = navigator.language) {
  return String(language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(() => detectLocale());

  useEffect(() => {
    chrome.storage.local.get({ [LOCALE_STORAGE_KEY]: "" }).then(result => {
      const stored = result[LOCALE_STORAGE_KEY];
      if (stored === "zh" || stored === "en") setLocaleState(stored);
    });
  }, []);

  const setLocale = (nextLocale) => {
    const normalized = nextLocale === "zh" ? "zh" : "en";
    setLocaleState(normalized);
    void chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: normalized });
  };

  const t = (key, values = {}) => {
    const message = MESSAGES[locale]?.[key] || MESSAGES.en[key] || key;
    return String(message).replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "");
  };
  return <LocaleContext.Provider value={{ locale, setLocale, t }}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const context = useContext(LocaleContext);
  if (!context) {
    // Isolated component tests render without the application provider.
    // Keep their legacy Chinese fixtures stable; real UI always has a provider.
    const locale = "zh";
    return {
      locale,
      setLocale: () => {},
      t: (key, values = {}) => String(MESSAGES[locale]?.[key] || MESSAGES.en[key] || key)
        .replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "")
    };
  }
  return context;
}

export function useLocalizedDom() {
  const { locale } = useI18n();
  const [root, setRoot] = useState(null);
  const rootRef = useCallback((node) => setRoot(node), []);

  useEffect(() => {
    if (!root) return undefined;
    const source = locale === "en" ? UI_TEXT : Object.fromEntries(Object.entries(UI_TEXT).map(([zh, en]) => [en, zh]));
    const translate = () => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        const value = node.nodeValue;
        const trimmed = value.trim();
        if (!source[trimmed]) continue;
        node.nodeValue = value.replace(trimmed, source[trimmed]);
      }
      for (const element of root.querySelectorAll("[aria-label], [placeholder], [title]")) {
        for (const attribute of ["aria-label", "placeholder", "title"]) {
          const value = element.getAttribute(attribute);
          if (source[value]) element.setAttribute(attribute, source[value]);
        }
      }
    };
    translate();
    const observer = new MutationObserver(translate);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [locale, root]);

  return rootRef;
}
