/* global chrome */
import { Button, Card, Dialog } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import { streamChat, executeTool } from "../../api/llm";
import { connectMcpServer, listMcpResources, readMcpResource } from "../../api/mcp";
import { generateSessionId, listSessions, createSession, loadSession, loadSessionMeta, saveSession, saveSessionMeta, deleteSession, extractTitle } from "../../api/sessions";
import {
  EMPTY_AGENT_SKILLS,
  buildSkillsSystemPrompt,
  loadAgentSkills,
  saveAgentSkills,
  mergeBridgeToolDangerous,
  mergeAgentSkillsServerUrl,
  mergeLoadedSkills
} from "../../api/skills";
import ChatMessageList from "./ChatMessageList";
import McpConfig from "./McpConfig";
import UserProfilePanel from "./UserProfilePanel";
import SkillsConfig from "./SkillsConfig";
import toast from "react-hot-toast";
import { formatProfileForSystemPrompt } from "../../api/userProfile";
import "./chat.css";

const SYSTEM_PROMPT_PLACEHOLDER =
  "例如：你是一位情感大师，擅长共情、倾听和温柔地拆解亲密关系问题。回答时先复述用户感受，再给出具体可执行的沟通建议；避免评判，语气温暖、真诚、稳定。";

/**
 * Main Agent chat panel with session management.
 * - Auto-saves conversation to chrome.storage.local
 * - Toolbar at top: new session / title / history dropdown
 * - Restores last session on mount
 */
export default function AgentPanel() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionSystemPrompt, setSessionSystemPrompt] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [mcpTools, setMcpTools] = useState([]);   // MCP tools from connected servers
  const [agentSkills, setAgentSkills] = useState(EMPTY_AGENT_SKILLS);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillStationTools, setSkillStationTools] = useState([]);
  const [platformInfo, setPlatformInfo] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const historyRef = useRef(null);
  const activeSessionIdRef = useRef(null);
  const sessionMessagesRef = useRef(new Map());
  const sessionRuntimeRef = useRef(new Map());
  const [pendingApproval, setPendingApproval] = useState(null);
  const approvalResolverRef = useRef(new Map());

  /** Auto-scroll to bottom when messages change */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /** Initialize: load last session or create a new one */
  useEffect(() => {
    (async () => {
      const allSessions = await listSessions();
      setSessions(allSessions);
      if (allSessions.length > 0) {
        // Restore the most recent session
        const latest = allSessions[0];
        const [msgs, meta] = await Promise.all([
          loadSession(latest.id),
          loadSessionMeta(latest.id)
        ]);
        sessionMessagesRef.current.set(latest.id, msgs);
        activeSessionIdRef.current = latest.id;
        setSessionId(latest.id);
        setSessionTitle(latest.title);
        setSessionSystemPrompt(meta.systemPrompt || "");
        setMessages(msgs);
        setLoading(false);
      } else {
        // Create a fresh session
        const id = generateSessionId();
        await createSession(id, "新会话");
        sessionMessagesRef.current.set(id, []);
        activeSessionIdRef.current = id;
        setSessionId(id);
        setSessionTitle("新会话");
        setSessionSystemPrompt("");
        setMessages([]);
        setLoading(false);
        setSessions(await listSessions());
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const savedSkills = await loadAgentSkills();
      setAgentSkills(savedSkills);
      if (savedSkills.serverUrl) {
        try {
          setSkillStationTools(await loadSkillStationTools(savedSkills.serverUrl, savedSkills.bridgeToolSettings));
        } catch (error) {
          console.error("Failed to restore skill-bridge tools:", error);
          setSkillStationTools([]);
        }
      }
    })();
  }, []);

  useEffect(() => {
    chrome.runtime.getPlatformInfo((info) => {
      if (chrome.runtime.lastError) {
        console.error("Failed to get platform info:", chrome.runtime.lastError.message);
        return;
      }
      setPlatformInfo(info || null);
    });
  }, []);

  /** Close history dropdown when clicking outside */
  useEffect(() => {
    function handleClickOutside(e) {
      if (historyRef.current && !historyRef.current.contains(e.target)) {
        setShowHistory(false);
      }
    }
    if (showHistory) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showHistory]);

  const combinedMcpTools = mergeMcpToolLists(mcpTools, skillStationTools);

  /**
   * Save current session to storage.
   * Called after each completed LLM response.
   */
  async function autoSave(targetSessionId, msgs) {
    if (!targetSessionId) return;
    const title = extractTitle(msgs);
    await saveSession(targetSessionId, msgs, title);
    setSessions(await listSessions());
    if (activeSessionIdRef.current === targetSessionId) {
      setSessionTitle(title);
    }
  }

  function getSessionRuntime(targetSessionId) {
    return sessionRuntimeRef.current.get(targetSessionId) || {
      loading: false,
      abort: null,
      runId: 0,
      pendingApproval: null
    };
  }

  function setSessionRuntime(targetSessionId, patch) {
    const next = { ...getSessionRuntime(targetSessionId), ...patch };
    sessionRuntimeRef.current.set(targetSessionId, next);
    if (activeSessionIdRef.current === targetSessionId) {
      setLoading(!!next.loading);
      setPendingApproval(next.pendingApproval || null);
    }
    return next;
  }

  function isCurrentRun(targetSessionId, runId) {
    return getSessionRuntime(targetSessionId).runId === runId;
  }

  function getSessionMessages(targetSessionId) {
    return sessionMessagesRef.current.get(targetSessionId) || [];
  }

  function setSessionMessages(targetSessionId, msgs) {
    sessionMessagesRef.current.set(targetSessionId, msgs);
    if (activeSessionIdRef.current === targetSessionId) {
      setMessages(msgs);
    }
  }

  async function openSession(id) {
    const cached = sessionMessagesRef.current.get(id);
    const [msgs, meta] = await Promise.all([
      cached ?? loadSession(id),
      loadSessionMeta(id)
    ]);
    sessionMessagesRef.current.set(id, msgs);
    activeSessionIdRef.current = id;
    setSessionId(id);
    setSessionTitle(sessions.find(s => s.id === id)?.title || extractTitle(msgs) || "会话");
    setSessionSystemPrompt(meta.systemPrompt || "");
    setMessages(msgs);
    const runtime = getSessionRuntime(id);
    setLoading(!!runtime.loading);
    setPendingApproval(runtime.pendingApproval || null);
    setShowHistory(false);
  }

  function stopSessionGeneration(targetSessionId) {
    const runtime = getSessionRuntime(targetSessionId);
    if (runtime.abort) {
      runtime.abort();
    }
    const resolver = approvalResolverRef.current.get(targetSessionId);
    if (resolver) {
      approvalResolverRef.current.delete(targetSessionId);
      resolver(false);
    }
    setSessionRuntime(targetSessionId, {
      loading: false,
      abort: null,
      runId: runtime.runId + 1,
      pendingApproval: null
    });
  }

  function isSessionAwaitingApproval(targetSessionId) {
    return !!getSessionRuntime(targetSessionId).pendingApproval;
  }

  function requestDangerousToolApproval(targetSessionId, runId, toolCall, approvalMeta) {
    return new Promise((resolve) => {
      approvalResolverRef.current.set(targetSessionId, resolve);
      setSessionRuntime(targetSessionId, {
        loading: false,
        abort: null,
        pendingApproval: {
          runId,
          toolCall,
          approvalMeta
        }
      });
    });
  }

  function getDangerousToolMeta(toolCall) {
    if (!toolCall) return null;
    if (toolCall.name === "schedule_tool") {
      const scheduledToolMeta = getDirectDangerousToolMeta(toolCall.args?.toolName, toolCall.args?.toolArgs);
      if (!scheduledToolMeta) return null;
      const scheduledTimestamp = resolveScheduledFireTimestamp(toolCall.args);
      const scheduledFireAt = formatScheduledFireAt(scheduledTimestamp);
      const originalArgs = toolCall.args || {};
      const restArgs = { ...originalArgs };
      delete restArgs.delaySeconds;
      return {
        title: "危险定时任务待确认",
        description:
          `${scheduledToolMeta.toolLabel} 将于 ${scheduledFireAt || "未来某个时间"} 自动执行。` +
          `请确认参数无误后再创建该定时任务。`,
        displayArgs: {
          toolName: toolCall.args?.toolName,
          label: toolCall.args?.label || toolCall.args?.toolName,
          fireAt: scheduledFireAt,
          delaySeconds: toolCall.args?.delaySeconds,
          timestamp: toolCall.args?.timestamp,
          timeoutSeconds: toolCall.args?.timeoutSeconds,
          toolArgs: toolCall.args?.toolArgs || {}
        },
        confirmLabel: "确认创建任务",
        executeArgs: scheduledTimestamp != null
          ? { ...restArgs, timestamp: scheduledTimestamp }
          : { ...originalArgs }
      };
    }
    return getDirectDangerousToolMeta(toolCall.name, toolCall.args);
  }

  function getDirectDangerousToolMeta(toolName, toolArgs) {
    if (toolName === "eval_js") {
      return {
        title: "危险工具待确认",
        description: "`eval_js` 将在当前页面执行任意 JavaScript。请确认参数无误后再执行。",
        displayArgs: toolArgs || {},
        confirmLabel: "确认执行",
        executeArgs: toolArgs || {},
        toolLabel: "危险工具 `eval_js`"
      };
    }
    if (toolName?.startsWith("mcp_")) {
      const mcpTool = combinedMcpTools.find(tool => tool._toolCallName === toolName);
      if (mcpTool?._dangerous) {
        return {
          title: "危险 MCP 工具待确认",
          description: `MCP 工具「${mcpTool._serverName || "MCP Server"} / ${mcpTool.name}」被标记为危险工具。请确认参数无误后再执行。`,
          displayArgs: toolArgs || {},
          confirmLabel: "确认执行",
          executeArgs: toolArgs || {},
          toolLabel: `危险 MCP 工具「${mcpTool._serverName || "MCP Server"} / ${mcpTool.name}」`
        };
      }
    }
    return null;
  }

  function resolveScheduledFireTimestamp(scheduleArgs) {
    if (Number.isFinite(Number(scheduleArgs?.timestamp))) {
      return Number(scheduleArgs.timestamp);
    }
    if (Number.isFinite(Number(scheduleArgs?.delaySeconds)) && Number(scheduleArgs.delaySeconds) > 0) {
      return Date.now() + Number(scheduleArgs.delaySeconds) * 1000;
    }
    return null;
  }

  function formatScheduledFireAt(fireTimestamp) {
    if (!Number.isFinite(fireTimestamp)) return null;
    const fireDate = new Date(fireTimestamp);
    if (Number.isNaN(fireDate.getTime())) return null;
    return fireDate.toLocaleString();
  }

  function resolveDangerousToolApproval(approved) {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;
    const runtime = getSessionRuntime(currentSessionId);
    const resolver = approvalResolverRef.current.get(currentSessionId);
    approvalResolverRef.current.delete(currentSessionId);
    setSessionRuntime(currentSessionId, {
      pendingApproval: null,
      loading: approved && !!runtime.loading ? runtime.loading : false
    });
    if (resolver) resolver(approved);
  }

  /** Create a new empty session */
  async function handleNewSession() {
    // Save current session first if it has messages
    const currentSessionId = activeSessionIdRef.current;
    if (currentSessionId) {
      const currentMessages = getSessionMessages(currentSessionId);
      if (currentMessages.length > 0) {
        await autoSave(currentSessionId, currentMessages);
      }
    }
    const id = generateSessionId();
    await createSession(id, "新会话");
    sessionMessagesRef.current.set(id, []);
    setSessionRuntime(id, { loading: false, abort: null, runId: 0 });
    activeSessionIdRef.current = id;
    setSessionId(id);
    setSessionTitle("新会话");
    setSessionSystemPrompt("");
    setMessages([]);
    setLoading(false);
    setSessions(await listSessions());
    setShowHistory(false);
  }

  /** Switch to a historical session */
  async function switchSession(id) {
    // Save current session first
    const currentSessionId = activeSessionIdRef.current;
    if (currentSessionId && currentSessionId !== id) {
      const currentMessages = getSessionMessages(currentSessionId);
      if (currentMessages.length > 0) {
        await autoSave(currentSessionId, currentMessages);
      }
    }
    await openSession(id);
  }

  /** Delete a session from history */
  async function handleDeleteSession(id, e) {
    e.stopPropagation();
    stopSessionGeneration(id);

    sessionMessagesRef.current.delete(id);
    sessionRuntimeRef.current.delete(id);
    await deleteSession(id);
    const updated = await listSessions();
    setSessions(updated);
    // If deleted the current session, switch to another or create new
    if (id === sessionId) {
      if (updated.length > 0) {
        await switchSession(updated[0].id);
      } else {
        await handleNewSession();
      }
    }
  }

  // ==================== LLM Chat Logic ====================

  async function buildSystemPrompt() {
    const memoryBlock = await formatProfileForSystemPrompt().catch(() => "");
    const platformBlock = buildPlatformSystemPrompt(platformInfo);
    const currentSessionSystemPrompt = sessionSystemPrompt.trim()
      ? `\n\nAdditional system instructions for this conversation:\n${sessionSystemPrompt.trim()}\n`
      : "";
    return (
      `You are a browser assistant running inside a browser environment.\n\n` +
      `You can use browser tools to inspect open tabs, tab groups, and windows, focus tabs and windows, move tabs between windows, open tabs, close tabs, create windows, close windows, group tabs, update groups, inspect page DOM, interact with page elements, extract page content, and search browser history.\n\n` +
      platformBlock +
      `Important rules:\n` +
      `- Do not assume you already know the current browser state. Tabs and windows can change at any time.\n` +
      `- If the user asks about open tabs, browser context, which page they are on, or any page-related question where the target tab is unclear, first call tab_list and/or tab_get_active to refresh context.\n` +
      `- If the user asks about tab groups, grouped tabs, or tab organization, first call group_list and/or group_get to refresh group context.\n` +
      `- If the user asks about windows, tab placement across windows, or moving work between windows, first call window_list and/or window_get_current to refresh context.\n` +
      `- If the user asks you to inspect, find, click, fill, style, or locate something on the current page, first use dom_query to inspect the DOM, then use dom_click, dom_set_value, dom_style, dom_get_html, or dom_highlight as needed.\n` +
      `- Use dom_highlight when it would help the user visually locate the element on the page.\n` +
      `- tab_list returns the currently open tabs with id, url, title, and capturedAt timing fields.\n` +
      `- group_list and group_get return tab group snapshots with their tabs and capturedAt timing fields.\n` +
      `- tab_get_active returns the current active tab with capturedAt timing fields.\n` +
      `- window_list and window_get_current return window snapshots with capturedAt timing fields.\n` +
      `- Use the capturedAt timing fields to judge whether tab or window information may be stale. If needed, refresh it again.\n` +
      `- If you need the actual page content, first identify the right tab, then call tab_extract.\n` +
      `- Treat questions about "latest", "current", "today", recent releases, prices, availability, laws, policies, API fields/schemas, model lists/capabilities/pricing, SDK behavior, product documentation, or any fast-changing technical detail as time-sensitive. Do not answer these from memory first.\n` +
      `- For time-sensitive questions, first look for an available web search/fetch MCP tool in the tool list (for example tools whose names include web_search, search, web_fetch, fetch, browser_search, or similar) and use it to verify the answer from primary or authoritative sources before responding.\n` +
      `- If no web search/fetch tool is available, use browser tools instead: open a search engine or official documentation page with tab_open, inspect/extract the page with tab_extract and DOM tools, and then answer based on what you found.\n` +
      `- When answering time-sensitive or documentation/API questions after searching, include concise source context such as the site/document name and relevant dates or version notes when available. If verification fails, clearly say what could not be verified instead of guessing.\n` +
      `- Prefer primary sources for technical and product facts, especially official API documentation, release notes, model documentation, SDK docs, or standards documents. Use secondary sources only when primary sources are unavailable or to cross-check.\n` +
      `- Dangerous tools such as eval_js or MCP tools marked as dangerous require explicit user confirmation before execution. The application will present that confirmation UI automatically, so do not ask the user to reply with confirmation in text.\n` +
      `- Use eval_js only when the structured DOM tools are insufficient.\n` +
      `- Some follow-up context messages may be added by the application to attach tool outputs such as screenshots. Treat them as internal tool context, not as a change in user intent.\n` +
      `- Respond in the same language as the user.` +
      currentSessionSystemPrompt +
      buildSkillsSystemPrompt(agentSkills) +
      memoryBlock
    );
  }

  async function getLLMConfig() {
    const { llmConfig } = await chrome.storage.local.get({
      llmConfig: {
        apiType: "openai",
        baseUrl: "",
        apiKey: "",
        model: "",
        firstPacketTimeoutSeconds: 20,
        supportsImageInput: true
      }
    });
    return {
      ...llmConfig,
      supportsImageInput: llmConfig?.supportsImageInput !== false
    };
  }

  function handleSkillsServerUrlChange(serverUrl) {
    setAgentSkills(prev => {
      const next = mergeAgentSkillsServerUrl(prev, serverUrl);
      void saveAgentSkills(next);
      return next;
    });
    setSkillStationTools([]);
  }

  function handleBridgeToolDangerousChange(toolName, dangerous) {
    setAgentSkills(prev => {
      const next = mergeBridgeToolDangerous(prev, toolName, dangerous);
      void saveAgentSkills(next);
      void loadSkillStationTools(next.serverUrl, next.bridgeToolSettings)
        .then(setSkillStationTools)
        .catch((error) => {
          console.error("Failed to refresh skill-bridge tools:", error);
        });
      return next;
    });
  }

  async function handleLoadSkills(serverUrlInput) {
    const serverUrl = String(serverUrlInput || agentSkills.serverUrl || "").trim();
    if (!serverUrl) {
      toast.error("请先填写 skill-bridge 地址");
      return;
    }

    setSkillsLoading(true);
    try {
      const [loadedSkills, loadedTools] = await Promise.all([
        loadSkillsIndexFromSkillStation(serverUrl),
        loadSkillStationTools(serverUrl, agentSkills.bridgeToolSettings)
      ]);
      const next = mergeLoadedSkills(agentSkills, serverUrl, loadedSkills);
      const saved = await saveAgentSkills(next);
      setAgentSkills(saved);
      setSkillStationTools(loadedTools);
      toast.success(`已加载 ${saved.skills.length} 个 skill`);
    } catch (error) {
      console.error("Failed to load skills index:", error);
      toast.error(`Skills 加载失败: ${error.message || String(error)}`);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const config = await getLLMConfig();
    if (!config.apiKey || !config.baseUrl) {
      toast.error("请先在设置中配置 LLM API");
      return;
    }

    const userMsg = { role: "user", content: text };
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;
    const newMessages = [...getSessionMessages(currentSessionId), userMsg];
    setSessionMessages(currentSessionId, newMessages);
    setInput("");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    const nextRunId = getSessionRuntime(currentSessionId).runId + 1;
    setSessionRuntime(currentSessionId, { loading: true, abort: null, runId: nextRunId });

    void runConversation(config, currentSessionId, newMessages, nextRunId).catch(err => {
      console.error("Failed to start conversation:", err);
      toast.error(`发送失败: ${err.message || String(err)}`);
      setSessionRuntime(currentSessionId, { loading: false, abort: null });
    });
  }

  async function runConversation(config, targetSessionId, conversationMessages, runId) {
    if (!isCurrentRun(targetSessionId, runId)) return;
    const systemPrompt = await buildSystemPrompt();
    const apiConversationMessages = buildApiMessages(config.apiType, conversationMessages, {
      supportsImageInput: config.supportsImageInput !== false
    });
    const fullMessages = [{ role: "system", content: systemPrompt }, ...apiConversationMessages];

    let streamedContent = "";

    setSessionMessages(targetSessionId, [...conversationMessages, { role: "assistant", content: "", _streaming: true }]);

    const abort = streamChat(config, fullMessages, {
      onText: (chunk) => {
        if (!isCurrentRun(targetSessionId, runId)) return;
        streamedContent += chunk;
        const prevMessages = getSessionMessages(targetSessionId);
        const updated = [...prevMessages];
          // Only update the streaming placeholder, never overwrite tool messages
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]._streaming) {
            updated[lastIdx] = { role: "assistant", content: streamedContent, _streaming: true };
          }
        setSessionMessages(targetSessionId, updated);
      },

      onRetry: ({ nextAttempt, maxAttempts, error }) => {
        if (!isCurrentRun(targetSessionId, runId)) return;
        streamedContent = "";
        const prevMessages = getSessionMessages(targetSessionId);
        const updated = [...prevMessages];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx]._streaming) {
          updated[lastIdx] = { role: "assistant", content: "", _streaming: true };
        }
        setSessionMessages(targetSessionId, updated);
        toast(`LLM 重试中 (${nextAttempt}/${maxAttempts})：${error.code || "LLM_ERROR"}`, { duration: 1800 });
      },

      onDone: async (msg) => {
        if (!isCurrentRun(targetSessionId, runId)) return;
        try {
          // Streaming phase is over; clear the old request abort handle before tool execution.
          setSessionRuntime(targetSessionId, { abort: null, loading: true });

          if (!msg.toolCalls) {
            // Final response — replace streaming placeholder with clean message
            const finalMessages = [...conversationMessages, { role: "assistant", content: streamedContent }];
            setSessionMessages(targetSessionId, finalMessages);
            setSessionRuntime(targetSessionId, { loading: false, abort: null });
            await autoSave(targetSessionId, finalMessages);
            return;
          }

          const toolNames = [...new Set(msg.toolCalls.map(tc => tc.name))].join(", ");
          toast(`🔧 执行: ${toolNames}`, { duration: 2000 });

          const toolResults = [];
          for (const tc of msg.toolCalls) {
            if (!isCurrentRun(targetSessionId, runId)) return;
            let result;
            const dangerousMeta = getDangerousToolMeta(tc);
            if (dangerousMeta) {
              toast(`${dangerousMeta.title}：${tc.name}`, { duration: 2500 });
              const approved = await requestDangerousToolApproval(targetSessionId, runId, tc, dangerousMeta);
              if (!isCurrentRun(targetSessionId, runId)) return;
              if (!approved) {
                result = { error: "Execution canceled by user", cancelled: true };
              } else {
                setSessionRuntime(targetSessionId, { loading: true, pendingApproval: null });
                result = await executeTool(tc.name, dangerousMeta.executeArgs ?? tc.args, combinedMcpTools);
              }
            } else {
              result = await executeTool(tc.name, tc.args, combinedMcpTools);
            }
            if (!isCurrentRun(targetSessionId, runId)) return;
            toolResults.push({ id: tc.id, name: tc.name, args: tc.args, result });
          }

          if (!isCurrentRun(targetSessionId, runId)) return;

          const assistantMsg = buildAssistantToolCallMessage(config.apiType, streamedContent, msg);
          const toolResultMsgs = buildToolResultMessages(toolResults);

          const continuedMessages = [
            ...conversationMessages,
            assistantMsg,
            ...toolResultMsgs
          ];

          // Don't setMessages here — runConversation will set
          // [...continuedMessages, placeholder] which is a superset.
          // Setting both causes React 18 batching to skip this one,
          // and onText's prev may reference the wrong array.
          if (!isCurrentRun(targetSessionId, runId)) return;
          await runConversation(config, targetSessionId, continuedMessages, runId);
        } catch (err) {
          if (!isCurrentRun(targetSessionId, runId)) return;
          console.error("Failed to continue conversation after tool execution:", err);
          toast.error(`工具执行后续跑失败: ${err.message || String(err)}`);
          setSessionRuntime(targetSessionId, { loading: false, abort: null });
        }
      },

      onError: (err) => {
        if (!isCurrentRun(targetSessionId, runId)) return;
        toast.error(`LLM 错误: ${err.message}`);
        const finalMessages = replaceStreamingPlaceholder(
          getSessionMessages(targetSessionId),
          buildLlmErrorDisplayMessage(err)
        );
        setSessionMessages(targetSessionId, finalMessages);
        setSessionRuntime(targetSessionId, { loading: false, abort: null });
        void autoSave(targetSessionId, finalMessages);
      }
    }, combinedMcpTools, {
      sessionId: targetSessionId,
      supportsImageInput: config.supportsImageInput !== false
    });

    if (!isCurrentRun(targetSessionId, runId)) {
      abort();
      return;
    }
    setSessionRuntime(targetSessionId, { abort, loading: true });
  }

  function stopGeneration() {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;
    stopSessionGeneration(currentSessionId);
  }

  async function handleClearCurrentSession() {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;
    stopSessionGeneration(currentSessionId);
    setSessionMessages(currentSessionId, []);
    setInput("");
    setSessionTitle("新会话");
    setSessionSystemPrompt("");
    await saveSessionMeta(currentSessionId, { systemPrompt: "" });
    await saveSession(currentSessionId, [], "新会话");
    setSessions(await listSessions());
  }

  async function handleExportCurrentSession() {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;

    const currentMessages = getSessionMessages(currentSessionId);
    if (!Array.isArray(currentMessages) || currentMessages.length === 0) {
      toast("当前会话还没有可导出的内容", { duration: 2500 });
      return;
    }

    const markdown = buildSessionExportMarkdown({
      title: sessionTitle || "新会话",
      sessionId: currentSessionId,
      messages: currentMessages
    });

    try {
      downloadMarkdownFile(`${currentSessionId}.md`, markdown);
      toast.success(`已导出 ${currentSessionId}.md`);
    } catch (error) {
      console.error("Failed to export session:", error);
      toast.error(`导出失败: ${error.message || String(error)}`);
    }
  }

  async function handleSaveSessionSystemPrompt(systemPrompt) {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;
    const normalizedPrompt = String(systemPrompt || "").trim();
    await saveSessionMeta(currentSessionId, { systemPrompt: normalizedPrompt });
    setSessionSystemPrompt(normalizedPrompt);
    setSessions(await listSessions());
    toast.success(normalizedPrompt ? "系统提示已保存" : "系统提示已清空");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  }

  /**
   * Truncate history to messages before this user message; put that message text in the input for editing.
   */
  function handleRewindToUserMessage(index) {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId || typeof index !== "number" || index < 0) return;

    const msgs = getSessionMessages(currentSessionId);
    if (index >= msgs.length) return;

    const target = msgs[index];
    if (target?.role !== "user" || Array.isArray(target.content)) return;

    const text = typeof target.content === "string" ? target.content : String(target.content ?? "");
    stopSessionGeneration(currentSessionId);

    const truncated = msgs.slice(0, index);
    setSessionMessages(currentSessionId, truncated);
    setInput(text);
    void autoSave(currentSessionId, truncated);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function isSessionLoading(targetSessionId) {
    return !!getSessionRuntime(targetSessionId).loading;
  }

  // ==================== Render ====================

  const pendingApprovalMeta = pendingApproval?.approvalMeta || getDangerousToolMeta(pendingApproval?.toolCall);

  return (
    <div className="agent-panel">
      <div className="chat-toolbar">
        <button className="chat-toolbar-btn" onClick={handleNewSession}>+ 新建</button>
        <Dialog trigger={<button className="chat-toolbar-btn">系统</button>}>
          <SessionSystemPromptDialogBody
            initialValue={sessionSystemPrompt}
            onSave={handleSaveSessionSystemPrompt}
          />
        </Dialog>
        <button className="chat-toolbar-btn" onClick={handleClearCurrentSession}>清空</button>
        <button className="chat-toolbar-btn" onClick={handleExportCurrentSession}>导出</button>
        <Dialog trigger={<button className="chat-toolbar-btn">调度</button>}>
          <ScheduleJobsDialogBody />
        </Dialog>
        <span className="chat-session-title">{sessionTitle || "新会话"}</span>
        <div className="chat-history-wrapper" ref={historyRef}>
          <button className="chat-toolbar-btn" onClick={() => { setShowHistory(!showHistory); }}>
            历史 {showHistory ? "▲" : "▼"}
          </button>
          {showHistory && (
            <div className="chat-history-dropdown">
              {sessions.length === 0 && (
                <div className="chat-history-empty">暂无历史会话</div>
              )}
              {sessions.map(s => (
                <div
                  key={s.id}
                  className={`chat-history-item ${s.id === sessionId ? "chat-history-active" : ""}`}
                  onClick={() => switchSession(s.id)}
                >
                  <div className="chat-history-item-info">
                    <span className="chat-history-item-title">
                      {s.title}
                      {s.id !== sessionId && isSessionAwaitingApproval(s.id) && (
                        <span className="chat-history-item-status chat-history-item-status-pending">● 待确认</span>
                      )}
                      {s.id !== sessionId && isSessionLoading(s.id) && (
                        <span className="chat-history-item-status">● 生成中</span>
                      )}
                    </span>
                    <span className="chat-history-item-time">{formatTime(s.updatedAt)}</span>
                  </div>
                  <button
                    className="chat-history-item-delete"
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    aria-label={`删除会话 ${s.title || ""}`.trim()}
                    title="删除"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div>
              <p>👋 你好，我是浏览器助手</p>
              <p style={{ marginTop: "8px" }}>我可以通过工具获取当前标签页和浏览器上下文</p>
              <p>也可以读取页面内容来回答问题</p>
            </div>
          </div>
        ) : (
          <>
            <ChatMessageList
              messages={messages}
              onRewindToUserMessage={handleRewindToUserMessage}
            />
            {loading && messages[messages.length - 1]?.content === "" && (
              <div className="chat-msg chat-msg-assistant">
                <div className="chat-bubble chat-bubble-assistant loading-dots">思考中</div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        {pendingApproval && (
          <Card className="!p-2 !mb-1">
            <div className="text-xs font-semibold text-red-600 mb-1">
              {pendingApprovalMeta?.title || "危险工具待确认"}
            </div>
            <div className="text-xs text-gray-600 mb-2">
              {pendingApprovalMeta?.description || "该工具被标记为危险工具。"}
            </div>
            <pre className="tool-result-content" style={{ marginBottom: "8px" }}>
              {JSON.stringify(pendingApprovalMeta?.displayArgs ?? pendingApproval.toolCall?.args ?? {}, null, 2)}
            </pre>
            <div className="chat-input-actions" style={{ justifyContent: "flex-end", gap: "6px" }}>
              <Button className="!text-xs" onPress={() => resolveDangerousToolApproval(false)}>取消</Button>
              <Button className="!text-xs" onPress={() => resolveDangerousToolApproval(true)}>
                {pendingApprovalMeta?.confirmLabel || "确认执行"}
              </Button>
            </div>
          </Card>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          rows={3}
          disabled={loading || !!pendingApproval}
        />
        <div className="chat-input-actions">
          <div className="chat-input-actions-left">
            <UserProfilePanel />
          </div>
          <div className="chat-input-actions-right">
            <SkillsConfig
              agentSkills={agentSkills}
              loading={skillsLoading}
              skillToolConnected={skillStationTools.length > 0}
              skillBridgeTools={skillStationTools}
              onServerUrlChange={handleSkillsServerUrlChange}
              onBridgeToolDangerousChange={handleBridgeToolDangerousChange}
              onLoad={handleLoadSkills}
            />
            <McpConfig onToolsChanged={setMcpTools} />
            {loading ? (
              <Button className="!text-xs" onPress={stopGeneration}>停止</Button>
            ) : (
              <Button className="!text-xs" onPress={sendMessage} isDisabled={!!pendingApproval}>发送</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== Helper functions ====================

function SessionSystemPromptDialogBody({ initialValue = "", onSave }) {
  const [draft, setDraft] = useState(initialValue || "");
  const [saving, setSaving] = useState(false);
  const rootRef = useRef(null);

  function closeDialog() {
    const closeButton = rootRef.current?.closest(".dialog-backdrop")?.querySelector(".dialog-close-button");
    closeButton?.click();
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave?.(draft);
      closeDialog();
    } catch (error) {
      toast.error(`保存失败: ${error?.message || String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={rootRef} className="system-prompt-dialog">
      <div>
        <div className="schedule-dialog-title">当前会话系统提示</div>
        <div className="schedule-dialog-subtitle">保存后只影响当前会话，会作为额外 system prompt 注入。</div>
      </div>
      <textarea
        className="system-prompt-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={SYSTEM_PROMPT_PLACEHOLDER}
      />
      <div className="schedule-dialog-actions">
        <Button
          className="!min-h-8 !px-3 !text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
          onPress={closeDialog}
          isDisabled={saving}
        >
          取消
        </Button>
        <Button
          className="!min-h-8 !px-3 !text-xs !whitespace-nowrap"
          onPress={handleSave}
          isDisabled={saving}
        >
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}

function ScheduleJobsDialogBody() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearingCompleted, setClearingCompleted] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let disposed = false;

    async function loadJobs(showSpinner = false) {
      if (showSpinner) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      try {
        const result = await executeTool("list_scheduled", {});
        if (disposed) return;
        if (result?.error) {
          throw new Error(result.error);
        }
        setJobs(Array.isArray(result?.scheduled) ? result.scheduled : []);
        setError("");
      } catch (err) {
        if (disposed) return;
        setError(err?.message || String(err));
      } finally {
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    loadJobs(true);
    const refreshIntervalId = setInterval(() => {
      loadJobs(false);
    }, 5000);
    const clockIntervalId = setInterval(() => {
      if (!disposed) setNow(Date.now());
    }, 1000);

    return () => {
      disposed = true;
      clearInterval(refreshIntervalId);
      clearInterval(clockIntervalId);
    };
  }, []);

  const hasCompletedJobs = jobs.some((job) => isTerminalScheduleStatus(job?.status));

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const result = await executeTool("list_scheduled", {});
      if (result?.error) {
        throw new Error(result.error);
      }
      setJobs(Array.isArray(result?.scheduled) ? result.scheduled : []);
      setError("");
    } catch (err) {
      setError(err?.message || String(err));
      toast.error(`刷新调度列表失败: ${err?.message || String(err)}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleClearCompleted() {
    setClearingCompleted(true);
    try {
      const result = await executeTool("clear_completed_scheduled", {});
      if (result?.error) {
        throw new Error(result.error);
      }
      const removedCount = Number(result?.removedCount) || 0;
      setJobs((currentJobs) => currentJobs.filter((job) => !isTerminalScheduleStatus(job?.status)));
      setError("");
      toast.success(removedCount > 0 ? `已清理 ${removedCount} 个完成的 job` : "没有可清理的已完成 job");
    } catch (err) {
      setError(err?.message || String(err));
      toast.error(`清理完成 job 失败: ${err?.message || String(err)}`);
    } finally {
      setClearingCompleted(false);
    }
  }

  return (
    <div className="schedule-dialog">
      <div className="schedule-dialog-header">
        <div>
          <div className="schedule-dialog-title">Schedule Jobs</div>
          <div className="schedule-dialog-subtitle">显示待执行任务和最近 24 小时内的执行记录</div>
        </div>
        <div className="schedule-dialog-actions">
          <Button
            className="!min-h-8 !px-3 !text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
            onPress={handleRefresh}
            isDisabled={loading || refreshing || clearingCompleted}
          >
            {refreshing ? "刷新中..." : "刷新"}
          </Button>
          <Button
            className="!min-h-8 !px-3 !text-xs !whitespace-nowrap !bg-red-50 !text-red-700 !border !border-red-200 hover:!bg-red-100"
            onPress={handleClearCompleted}
            isDisabled={loading || refreshing || clearingCompleted || !hasCompletedJobs}
          >
            {clearingCompleted ? "删除中..." : "删除结束项"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="schedule-dialog-error">加载失败: {error}</div>
      )}

      {loading && jobs.length === 0 ? (
        <div className="schedule-dialog-empty">正在加载任务…</div>
      ) : jobs.length === 0 ? (
        <div className="schedule-dialog-empty">当前没有可显示的 schedule job</div>
      ) : (
        <div className="schedule-job-list">
          {jobs.map((job) => (
            <Card key={job.id || job.scheduleId} className="schedule-job-card !p-3 !mb-2">
              <div className="schedule-job-row">
                <span className="schedule-job-label">{job.label || job.toolName || "未命名任务"}</span>
                <span className={`schedule-job-status schedule-job-status-${normalizeScheduleStatusClass(job.status)}`}>
                  {formatScheduleStatus(job.status)}
                </span>
              </div>
              <div className="schedule-job-meta">
                <span className="schedule-job-key">ID</span>
                <code className="schedule-job-value">{job.id || job.scheduleId}</code>
              </div>
              <div className="schedule-job-meta">
                <span className="schedule-job-key">预计执行时间</span>
                <span className="schedule-job-value">{job.fireAt || "-"}</span>
              </div>
              {job.status === "pending" && typeof job.remainingSeconds === "number" && (
                <div className="schedule-job-meta">
                  <span className="schedule-job-key">剩余时间</span>
                  <span className="schedule-job-value">
                    {formatRemainingSeconds(getLiveRemainingSeconds(job, now))}
                  </span>
                </div>
              )}
              {job.status === "failed" && job.error && (
                <div className="schedule-job-error">{job.error}</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function isTerminalScheduleStatus(status) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function buildSessionExportMarkdown({ title, sessionId, messages }) {
  const sections = [
    `# ${title || "新会话"}`,
    "",
    `- 导出时间: ${new Date().toLocaleString()}`,
    `- 会话 ID: ${sessionId || ""}`,
    ""
  ];

  for (const msg of messages || []) {
    sections.push(...serializeExportMessage(msg));
  }

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function serializeExportMessage(msg) {
  if (!msg || !msg.role) return [];

  if (msg.role === "user") {
    if (Array.isArray(msg.content)) return [];
    return [
      "---",
      "",
      "## 用户",
      "",
      String(msg.content ?? "").trim() || "_空内容_",
      ""
    ];
  }

  if (msg.role === "assistant") {
    return serializeAssistantExportMessage(msg);
  }

  if (msg.role === "tool") {
    return [
      `## 工具结果${msg.tool_name ? ` · ${msg.tool_name}` : ""}`,
      "",
      formatToolResultForMarkdown(msg),
      ""
    ];
  }

  if (msg.role === "error") {
    return [
      "## 错误",
      "",
      formatJsonFence(msg.content ?? {}),
      ""
    ];
  }

  return [
    `## ${msg.role}`,
    "",
    formatUnknownContentForMarkdown(msg.content),
    ""
  ];
}

function serializeAssistantExportMessage(msg) {
  const sections = [];

  if (typeof msg.content === "string" && msg.content.trim()) {
    sections.push("## 助手", "", msg.content.trim(), "");
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block) continue;
      if (block.type === "text" && block.text) {
        sections.push("## 助手", "", String(block.text).trim(), "");
      } else if (block.type === "tool_use") {
        sections.push(
          `## 工具调用${block.name ? ` · ${block.name}` : ""}`,
          "",
          formatJsonFence(block.input ?? {}),
          ""
        );
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall?.function?.name || toolCall?.name || "tool";
      let toolArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? toolCall?.args ?? {};
      if (typeof toolArgs === "string") {
        try {
          toolArgs = JSON.parse(toolArgs);
        } catch (error) {
          toolArgs = { raw: toolArgs };
        }
      }
      sections.push(
        `## 工具调用 · ${toolName}`,
        "",
        formatJsonFence(toolArgs),
        ""
      );
    }
  }

  if (sections.length === 0) {
    sections.push("## 助手", "", "_空内容_", "");
  }

  return sections;
}

function formatToolResultForMarkdown(msg) {
  const parsed = parseToolMessageContent(msg.content);
  const contentBlock = typeof parsed === "string"
    ? formatTextFence(parsed)
    : formatJsonFence(parsed ?? {});

  if (!msg.displayImageUrl) {
    return contentBlock;
  }

  return [
    contentBlock,
    "",
    `![工具截图](${msg.displayImageUrl})`
  ].join("\n");
}

function formatUnknownContentForMarkdown(content) {
  if (typeof content === "string") return content.trim() || "_空内容_";
  if (Array.isArray(content)) return formatJsonFence(content);
  if (content && typeof content === "object") return formatJsonFence(content);
  return "_空内容_";
}

function formatScheduleStatus(status) {
  switch (status) {
    case "pending": return "待执行";
    case "running": return "执行中";
    case "succeeded": return "已成功";
    case "failed": return "已失败";
    case "cancelled": return "已取消";
    default: return status || "未知";
  }
}

function normalizeScheduleStatusClass(status) {
  switch (status) {
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "unknown";
  }
}

function formatRemainingSeconds(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${secs}秒`;
  return `${secs}秒`;
}

function getLiveRemainingSeconds(job, now = Date.now()) {
  if (!job || job.status !== "pending") return 0;
  const fireAtMs = job.fireAt ? new Date(job.fireAt).getTime() : NaN;
  if (Number.isFinite(fireAtMs)) {
    return Math.max(0, Math.round((fireAtMs - now) / 1000));
  }
  return Math.max(0, Number(job.remainingSeconds) || 0);
}

function formatJsonFence(value) {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = String(value ?? "");
  }
  return `\`\`\`json\n${text}\n\`\`\``;
}

function formatTextFence(value) {
  return `\`\`\`text\n${String(value ?? "")}\n\`\`\``;
}

function downloadMarkdownFile(filename, markdown) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function buildAssistantToolCallMessage(apiType, textContent, doneMsg) {
  if (apiType === "anthropic") {
    return { role: "assistant", content: doneMsg.content };
  }
  return {
    role: "assistant",
    content: textContent || null,
    tool_calls: doneMsg._openaiToolCalls
  };
}

function buildToolResultMessages(toolResults) {
  return toolResults.map(tr => buildDisplayToolResultMessage(tr));
}

function replaceStreamingPlaceholder(messages, replacement) {
  const updated = [...(messages || [])];
  const lastIdx = updated.length - 1;
  if (lastIdx >= 0 && updated[lastIdx]?._streaming) {
    updated[lastIdx] = replacement;
    return updated;
  }
  updated.push(replacement);
  return updated;
}

function buildLlmErrorDisplayMessage(error) {
  const code = error?.code || "LLM_ERROR";
  const message = error?.message || "LLM 请求失败";
  const failures = Array.isArray(error?.failures) ? error.failures : [];
  return {
    role: "error",
    content: {
      code,
      message,
      status: error?.status || null,
      attempts: Number(error?.attempts) || failures.length || 1,
      maxAttempts: Number(error?.maxAttempts) || failures.length || 1,
      apiType: error?.apiType || "",
      failures,
      detail: error?.detail || null
    }
  };
}

function buildDisplayToolResultMessage(toolResult) {
  const parsedImage = parseImageDataUrl(toolResult?.result?.dataUrl);
  const summary = summarizeToolResult(toolResult.result);
  const serializedContent = serializeToolResult(summary);
  return {
    role: "tool",
    tool_call_id: toolResult.id,
    tool_name: toolResult.name,
    content: serializedContent,
    displayImageUrl: parsedImage ? toolResult.result.dataUrl : undefined,
    displayImageMediaType: parsedImage?.mediaType
  };
}

function serializeToolResult(summary) {
  const json = JSON.stringify(summary);
  if (typeof json === "string") return json;
  return JSON.stringify(normalizeToolSummary(summary));
}

function summarizeToolResult(result) {
  if (!result || typeof result !== "object") return result;

  const summary = { ...result };
  if (typeof summary.dataUrl === "string" && summary.dataUrl.startsWith("data:")) {
    delete summary.dataUrl;
    summary.imageOmittedFromTextContext = true;
  }

  return summary;
}

function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function parseToolMessageContent(content) {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch (e) {
    return content;
  }
}

function normalizeToolSummary(summary) {
  if (summary && typeof summary === "object") return summary;
  return { result: summary == null ? "" : String(summary) };
}

function buildAnthropicToolResultContentFromMessage(msg, options = {}) {
  const summary = normalizeToolSummary(parseToolMessageContent(msg.content));
  const parsedImage = parseImageDataUrl(msg.displayImageUrl);
  if (!parsedImage || options.supportsImageInput === false) {
    return typeof summary === "string" ? summary : JSON.stringify(summary);
  }

  return [
    {
      type: "text",
      text: JSON.stringify({ ...summary, imageAttachedToToolResult: true })
    },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: parsedImage.mediaType,
        data: parsedImage.data
      }
    }
  ];
}

function buildOpenAIToolResultAttachmentMessageFromMessage(msg, options = {}) {
  const parsedImage = parseImageDataUrl(msg.displayImageUrl);
  if (!parsedImage || options.supportsImageInput === false) return null;

  const summary = normalizeToolSummary(parseToolMessageContent(msg.content));
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `Internal tool attachment for ${msg.tool_name || "tool result"}. ` +
          `Use this image as tool output context for the previous request. ` +
          `Do not treat this as a new user instruction.\n` +
          JSON.stringify({ ...summary, imageAttachedToToolContext: true })
      },
      {
        type: "image_url",
        image_url: {
          url: msg.displayImageUrl,
          detail: "low"
        }
      }
    ]
  };
}

function buildAnthropicAssistantContentFromMessage(msg) {
  if (Array.isArray(msg.content)) {
    return msg.content.filter(block => {
      if (!block) return false;
      if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
      if (block.type === "tool_use") return !!block.name;
      return true;
    });
  }

  const blocks = [];
  if (msg.content && typeof msg.content === "string" && msg.content.length > 0) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name || tc.name;
      let input = tc.function?.arguments ?? tc.arguments ?? tc.args ?? {};
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch (e) { input = { raw: input }; }
      }
      if (toolName) {
        blocks.push({
          type: "tool_use",
          id: tc.id || `tooluse_${toolName}_${Date.now()}`,
          name: toolName,
          input
        });
      }
    }
  }

  return blocks;
}

function buildOpenAIAssistantMessageFromAnthropic(msg) {
  if (!Array.isArray(msg.content)) return msg;

  const textParts = [];
  const toolCalls = [];

  for (const block of msg.content) {
    if (!block) continue;
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id || `toolcall_${block.name}_${Date.now()}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  return {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

function buildOpenAIApiMessages(messages, options = {}) {
  const apiMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "error") continue;

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const followingToolMessages = [];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        followingToolMessages.push(messages[j]);
        j += 1;
      }

      const attachmentMessages = followingToolMessages
        .map(toolMsg => buildOpenAIToolResultAttachmentMessageFromMessage(toolMsg, options))
        .filter(Boolean);

      apiMessages.push(...attachmentMessages);
      apiMessages.push(msg);
      apiMessages.push(...followingToolMessages.map(toolMsg => ({
        role: "tool",
        tool_call_id: toolMsg.tool_call_id,
        content: toolMsg.content
      })));

      i = j - 1;
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      apiMessages.push(buildOpenAIAssistantMessageFromAnthropic(msg));
      continue;
    }

    if (msg.role === "tool") {
      apiMessages.push({
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: msg.content
      });
      continue;
    }

    apiMessages.push(msg);
  }

  return apiMessages;
}

function buildAnthropicApiMessages(messages, options = {}) {
  const apiMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "error") continue;

    if (msg.role === "tool") {
      const blocks = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        const toolMsg = messages[i];
        blocks.push({
          type: "tool_result",
          tool_use_id: toolMsg.tool_call_id,
          content: buildAnthropicToolResultContentFromMessage(toolMsg, options)
        });
        i += 1;
      }
      i -= 1;
      if (blocks.length > 0) {
        apiMessages.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const content = buildAnthropicAssistantContentFromMessage(msg);
      if (content.length === 0) continue;
      apiMessages.push({
        role: "assistant",
        content
      });
      continue;
    }

    apiMessages.push(msg);
  }

  return apiMessages;
}

function buildApiMessages(apiType, messages, options = {}) {
  if (apiType === "anthropic") {
    return buildAnthropicApiMessages(messages, options);
  }
  return buildOpenAIApiMessages(messages, options);
}

function buildPlatformSystemPrompt(platformInfo) {
  if (!platformInfo?.os) {
    return "";
  }

  const parts = [`Current operating system: ${platformInfo.os}`];
  if (platformInfo.arch) parts.push(`architecture: ${platformInfo.arch}`);
  if (platformInfo.nacl_arch) parts.push(`nacl_arch: ${platformInfo.nacl_arch}`);

  return `Environment:\n- ${parts.join("; ")}.\n\n`;
}

async function loadSkillsIndexFromSkillStation(serverUrl) {
  const normalizedServerUrl = normalizeSkillStationUrl(serverUrl);
  const connection = await connectMcpServer(normalizedServerUrl, {});
  if (connection.error) {
    throw new Error(connection.error);
  }
  const resources = await listMcpResources(normalizedServerUrl);
  const skillsIndex = resources.find(resource => resource?.uri === "skills://index");
  if (!skillsIndex) {
    throw new Error("skill-bridge 未暴露 skills://index 资源");
  }

  const resourceResult = await readMcpResource(normalizedServerUrl, {}, "skills://index");
  return parseLoadedSkillsResponse(extractResourceText(resourceResult));
}

function parseLoadedSkillsResponse(text) {
  const payloadText = extractJsonPayload(text);
  let payload;

  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    throw new Error("Skills 索引返回的不是合法 JSON");
  }

  if (payload?.error) {
    throw new Error(String(payload.error));
  }

  const rawSkills = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.skills) ? payload.skills : null);

  if (!rawSkills) {
    throw new Error("Skills 索引缺少 skills 数组");
  }

  return rawSkills
    .map(skill => ({
      path: String(skill?.directoryName || skill?.path || "").trim().replace(/\\/g, "/").replace(/^\.?\//, ""),
      name: String(skill?.name || "").trim(),
      description: String(skill?.description || "").trim(),
      header: {
        ...(skill?.metadata && typeof skill.metadata === "object" ? skill.metadata : {}),
        ...(skill?.header && typeof skill.header === "object" ? skill.header : {})
      }
    }))
    .filter(skill => !!skill.path);
}

async function loadSkillStationTools(serverUrl, bridgeToolSettings = {}) {
  const normalizedServerUrl = normalizeSkillStationUrl(serverUrl);
  const result = await connectMcpServer(normalizedServerUrl, {});
  if (result.error) {
    throw new Error(result.error);
  }

  const tools = Array.isArray(result.tools) ? result.tools : [];
  const hasGetSkillDetail = tools.some(tool => tool?.name === "get_skill_detail");
  if (!hasGetSkillDetail) {
    throw new Error("skill-bridge 缺少 get_skill_detail 工具");
  }

  return tools.map(tool => ({
    ...tool,
    _serverId: "skill_bridge",
    _serverName: "skill_bridge",
    _serverUrl: normalizedServerUrl,
    _serverHeaders: {},
    _dangerous: resolveSkillBridgeToolDangerous(tool.name, bridgeToolSettings),
    _toolCallName: `mcp_skill_bridge_${tool.name}`
  }));
}

function resolveSkillBridgeToolDangerous(toolName, bridgeToolSettings = {}) {
  const normalizedToolName = String(toolName || "").trim();
  const explicitDangerous = bridgeToolSettings?.[normalizedToolName]?.dangerous;
  if (explicitDangerous != null) {
    return !!explicitDangerous;
  }
  return normalizedToolName === "shell";
}

function normalizeSkillStationUrl(serverUrl) {
  return String(serverUrl || "").trim();
}

function extractResourceText(resourceResult) {
  const contents = Array.isArray(resourceResult?.contents) ? resourceResult.contents : [];
  const texts = contents
    .map(item => item?.text)
    .filter(text => typeof text === "string" && text.trim().length > 0);

  if (texts.length === 0) {
    throw new Error("skills://index 返回为空");
  }

  return texts.join("\n");
}

function mergeMcpToolLists(primaryTools, secondaryTools) {
  const map = new Map();
  for (const tool of [...(primaryTools || []), ...(secondaryTools || [])]) {
    if (!tool?._toolCallName) continue;
    map.set(tool._toolCallName, tool);
  }
  return [...map.values()];
}

function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Skills 索引返回为空");
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  if (raw.startsWith("{") || raw.startsWith("[")) return raw;

  const firstArrayStart = raw.indexOf("[");
  const lastArrayEnd = raw.lastIndexOf("]");
  if (firstArrayStart >= 0 && lastArrayEnd > firstArrayStart) {
    return raw.slice(firstArrayStart, lastArrayEnd + 1);
  }

  const firstObjectStart = raw.indexOf("{");
  const lastObjectEnd = raw.lastIndexOf("}");
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    return raw.slice(firstObjectStart, lastObjectEnd + 1);
  }

  throw new Error("未找到可解析的 JSON 输出");
}


