import { Button, Card, Input } from "@sunwu51/camel-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  createAcpSession,
  getAcpControllerBaseUrl,
  getAcpHealth,
  listAcpAgents,
  listAcpSessions,
  sendAcpPrompt,
  subscribeAcpSessionEvents,
} from "../../api/acpController";
import ChatMessageList from "../agent/ChatMessageList";
import "./acp.css";

const DEFAULT_CWD = "C:/Users/sunwu/Desktop/code/TabManager";

export default function AcpPanel() {
  const [health, setHealth] = useState(null);
  const [agents, setAgents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messagesBySession, setMessagesBySession] = useState({});
  const [statusBySession, setStatusBySession] = useState({});
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState(DEFAULT_CWD);
  const [selectedAgentId, setSelectedAgentId] = useState("codex");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const unsubscribeRef = useRef(null);
  const messagesEndRef = useRef(null);
  const activeSessionIdRef = useRef(null);
  const messagesBySessionRef = useRef({});
  const seenEventKeysRef = useRef(new Map());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );
  const activeMessages = messagesBySession[activeSessionId] || [];
  const activeStatus = activeSessionId ? (statusBySession[activeSessionId] || activeSession?.status) : null;

  useEffect(() => {
    refreshAll();
    return () => unsubscribeRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    messagesBySessionRef.current = messagesBySession;
  }, [messagesBySession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages.length, activeSessionId]);

  async function refreshAll() {
    setLoading(true);
    try {
      const [healthResult, agentsResult, sessionsResult] = await Promise.all([
        getAcpHealth(),
        listAcpAgents(),
        listAcpSessions(),
      ]);
      setHealth(healthResult);
      setAgents(agentsResult || []);
      setSessions(sessionsResult || []);
      if (!selectedAgentId && agentsResult?.[0]?.id) setSelectedAgentId(agentsResult[0].id);
      if (!activeSessionIdRef.current && sessionsResult?.[0]?.id) {
        selectSession(sessionsResult[0]);
      }
    } catch (error) {
      console.error(error);
      toast.error(`ACP Controller 连接失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateSession(agentId = selectedAgentId) {
    if (!agentId) {
      toast.error("请选择 Agent");
      return;
    }
    setLoading(true);
    try {
      const session = await createAcpSession({
        agentId,
        cwd: cwd.trim() || DEFAULT_CWD,
        title: `${agentId} session`,
      });
      const nextSessions = await listAcpSessions();
      setSessions(nextSessions || [session]);
      selectSession(session);
      toast.success(`已创建 ${agentId} 会话`);
    } catch (error) {
      console.error(error);
      toast.error(`创建会话失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  function selectSession(session) {
    if (!session?.id) return;
    unsubscribeRef.current?.();
    setActiveSessionId(session.id);
    setConnected(false);
    setStatusBySession((prev) => ({ ...prev, [session.id]: session.status }));

    const hasLocalMessages = (messagesBySessionRef.current[session.id] || []).length > 0;
    unsubscribeRef.current = subscribeAcpSessionEvents(session.id, {
      skipReplay: hasLocalMessages,
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      onEvent: (event) => handleAcpEvent(session.id, event),
    });
  }

  function handleAcpEvent(sessionId, event) {
    if (!event?.type) return;
    if (isDuplicateEvent(sessionId, event)) return;

    if (event.type === "session_status") {
      setStatusBySession((prev) => ({ ...prev, [sessionId]: event.status }));
      setSessions((prev) => prev.map((session) => session.id === sessionId ? { ...session, status: event.status } : session));
      return;
    }

    if (event.type === "session_update") {
      handleAcpUpdate(sessionId, event.update);
      return;
    }

    if (event.type === "prompt_done") {
      finalizeSessionMessages(sessionId);
      setStatusBySession((prev) => ({ ...prev, [sessionId]: "idle" }));
      return;
    }

    if (event.type === "permission_request") {
      appendMessage(sessionId, {
        role: "tool",
        tool_name: "permission_request",
        content: JSON.stringify(event.request, null, 2),
      });
      return;
    }

    if (event.type === "error") {
      appendMessage(sessionId, {
        role: "error",
        content: JSON.stringify({ message: event.message, detail: event.detail }, null, 2),
      });
    }
  }

  function isDuplicateEvent(sessionId, event) {
    const key = buildEventKey(event);
    if (!key) return false;
    let keys = seenEventKeysRef.current.get(sessionId);
    if (!keys) {
      keys = new Set();
      seenEventKeysRef.current.set(sessionId, keys);
    }
    if (keys.has(key)) return true;
    keys.add(key);
    if (keys.size > 5000) {
      const first = keys.values().next().value;
      keys.delete(first);
    }
    return false;
  }

  function handleAcpUpdate(sessionId, update) {
    if (!update || typeof update !== "object") return;
    const kind = update.sessionUpdate;

    if (kind === "user_message_chunk") {
      appendUserDelta(sessionId, extractTextContent(update.content));
      return;
    }

    if (kind === "agent_message_chunk") {
      appendAssistantDelta(sessionId, extractTextContent(update.content));
      return;
    }

    if (kind === "agent_thought_chunk") {
      const text = extractTextContent(update.content);
      if (text) appendMessage(sessionId, { role: "tool", tool_name: "thought", content: text });
      return;
    }

    if (kind === "tool_call") {
      appendMessage(sessionId, {
        role: "assistant",
        content: "",
        tool_calls: [{ name: update.title || update.kind || "tool", args: update }],
      });
      return;
    }

    if (kind === "tool_call_update") {
      appendMessage(sessionId, {
        role: "tool",
        tool_name: update.toolCallId || "tool_update",
        content: JSON.stringify(update, null, 2),
      });
      return;
    }

    if (["plan", "available_commands_update", "current_mode_update", "config_option_update"].includes(kind)) {
      appendMessage(sessionId, {
        role: "tool",
        tool_name: kind,
        content: JSON.stringify(update, null, 2),
      });
      return;
    }

    appendMessage(sessionId, {
      role: "tool",
      tool_name: kind || "session_update",
      content: JSON.stringify(update, null, 2),
    });
  }

  function appendMessage(sessionId, message) {
    setMessagesBySession((prev) => {
      const list = finalizeStreamingMessages([...(prev[sessionId] || [])]);
      return {
        ...prev,
        [sessionId]: [...list, message],
      };
    });
  }

  function appendUserDelta(sessionId, text) {
    if (!text) return;
    setMessagesBySession((prev) => {
      const list = [...(prev[sessionId] || [])];
      const last = list[list.length - 1];
      if (last?.role === "user" && last.__streaming) {
        list[list.length - 1] = { ...last, content: `${last.content || ""}${text}` };
      } else {
        const finalized = finalizeStreamingMessages(list);
        finalized.push({ role: "user", content: text, __streaming: true });
        return { ...prev, [sessionId]: finalized };
      }
      return { ...prev, [sessionId]: list };
    });
  }

  function appendAssistantDelta(sessionId, text) {
    if (!text) return;
    setMessagesBySession((prev) => {
      const list = [...(prev[sessionId] || [])];
      const last = list[list.length - 1];
      if (last?.role === "assistant" && last.__streaming) {
        list[list.length - 1] = { ...last, content: `${last.content || ""}${text}` };
      } else {
        const finalized = finalizeStreamingMessages(list);
        finalized.push({ role: "assistant", content: text, __streaming: true });
        return { ...prev, [sessionId]: finalized };
      }
      return { ...prev, [sessionId]: list };
    });
  }

  function finalizeSessionMessages(sessionId) {
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: finalizeStreamingMessages([...(prev[sessionId] || [])]),
    }));
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || !activeSessionId) return;
    setInput("");
    appendMessage(activeSessionId, { role: "user", content: text });
    setStatusBySession((prev) => ({ ...prev, [activeSessionId]: "running" }));
    try {
      await sendAcpPrompt(activeSessionId, text);
    } catch (error) {
      console.error(error);
      appendMessage(activeSessionId, {
        role: "error",
        content: JSON.stringify({ message: error.message, details: error.details }, null, 2),
      });
      setStatusBySession((prev) => ({ ...prev, [activeSessionId]: "error" }));
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  async function copyResumeCommand() {
    if (!activeSession?.acpSessionId) {
      toast.error("当前会话没有 ACP Session ID");
      return;
    }
    const command = buildResumeCommand(activeSession);
    await copyText(command);
    toast.success("已复制恢复命令");
  }
  return (
    <div className="acp-panel">
      <div className="acp-sidebar">
        <div className="acp-sidebar-header">
          <div className="acp-title">ACP Agents</div>
          <Button className="!text-xs !min-h-7" onPress={refreshAll} isDisabled={loading}>刷新</Button>
        </div>
        <div className={`acp-health ${health?.ok ? "acp-health-ok" : "acp-health-bad"}`}>
          Controller: {health?.ok ? `OK v${health.version}` : "未连接"}
          <div className="acp-url">{getAcpControllerBaseUrl()}</div>
        </div>

        <div className="acp-section-title">新建会话</div>
        <select className="acp-select" value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.displayName || agent.id} · {agent.status}</option>
          ))}
        </select>
        <Input
          aria-label="工作目录"
          inputClassName="!min-h-8 !text-xs"
          value={cwd}
          onChange={setCwd}
          placeholder="C:/path/to/workspace"
        />
        <Button className="!text-xs !min-h-8" onPress={() => handleCreateSession()} isDisabled={loading || !selectedAgentId}>
          + New Session
        </Button>

        <div className="acp-section-title">历史会话</div>
        <div className="acp-session-list">
          {sessions.length === 0 && <div className="acp-empty-small">暂无会话</div>}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`acp-session-item ${session.id === activeSessionId ? "acp-session-active" : ""}`}
              onClick={() => selectSession(session)}
            >
              <div className="acp-session-main">
                <span className="acp-session-title">{session.title || session.id}</span>
                <span className={`acp-session-status acp-session-status-${statusBySession[session.id] || session.status}`}>
                  {statusBySession[session.id] || session.status}
                </span>
              </div>
              <div className="acp-session-sub">{session.agentId} · {shortId(session.id)}</div>
              <div className="acp-session-sub">agent · {shortId(session.acpSessionId)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="acp-chat">
        <div className="chat-toolbar acp-chat-toolbar">
          {activeSession && (
            <button className="chat-toolbar-btn" onClick={copyResumeCommand} title={buildResumeCommand(activeSession)}>
              复制恢复
            </button>
          )}
          <span className="chat-session-title">
            {activeSession ? `${activeSession.agentId} / ${activeSession.title || activeSession.id}` : "请选择或新建 ACP 会话"}
          </span>
          {activeSession && <span className="acp-chat-meta">{activeStatus} · SSE {connected ? "已连接" : "未连接"}</span>}
        </div>

        <div className="chat-messages">
          {!activeSession ? (
            <div className="chat-empty">
              <div>
                <p>选择历史会话或新建 ACP 会话</p>
                <p style={{ marginTop: "8px" }}>这里会直接连接 acp-controller，不经过小助手转述。</p>
              </div>
            </div>
          ) : activeMessages.length === 0 ? (
            <div className="chat-empty">
              <div>
                <p>已连接 {activeSession.agentId}</p>
                <p style={{ marginTop: "8px" }}>输入消息开始和下游 Coding Agent 对话。</p>
              </div>
            </div>
          ) : (
            <ChatMessageList messages={activeMessages} />
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeSession ? "输入 ACP 消息... (Enter 发送, Shift+Enter 换行)" : "请先选择或新建会话"}
            rows={3}
            disabled={!activeSession || activeStatus === "running"}
          />
          <div className="chat-input-actions">
            <div className="chat-input-actions-left acp-input-hint">
              {activeSession?.cwd || cwd}
            </div>
            <div className="chat-input-actions-right">
              <Button className="!text-xs" onPress={handleSend} isDisabled={!activeSession || !input.trim() || activeStatus === "running"}>
                发送
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function finalizeStreamingMessages(list) {
  return list.map((message) => {
    if (!message?.__streaming) return message;
    const { __streaming, ...rest } = message;
    return rest;
  });
}

function buildEventKey(event) {
  if (!event || typeof event !== "object") return null;
  if (event.time) return `${event.type}:${event.time}`;
  if (event.type === "session_status") return `${event.type}:${event.status}`;
  if (event.type === "prompt_done") return `${event.type}:${event.turnId || JSON.stringify(event.result || {})}`;
  if (event.type === "session_created") return `${event.type}:${event.session?.id || ""}`;
  if (event.type === "session_update") return `${event.type}:${JSON.stringify(event.update || {})}`;
  return `${event.type}:${JSON.stringify(event)}`;
}

function extractTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text || "";
  if (Array.isArray(content)) return content.map(extractTextContent).join("");
  return "";
}

function shortId(id) {
  return String(id || "").slice(0, 10);
}

function buildResumeCommand(session) {
  const rawId = session?.acpSessionId || session?.id || "";
  const agentId = String(session?.agentId || "").toLowerCase();
  if (agentId.includes("codex")) return `codex resume ${rawId}`;
  if (agentId.includes("claude")) return `claude --resume ${rawId}`;
  return rawId;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}







