/* global chrome */
import { Button, Input } from "@sunwu51/camel-ui";
import { useEffect, useState, useRef, useCallback } from "react";

const DEFAULT_URL = "ws://localhost:3000/ws/tabmanager";
const MAX_RECORDS = 100;

/**
 * "工具透出" tab — configure WebSocket bridge to expose built-in tools as MCP.
 * Shows connection status and tool call history.
 */
export default function BridgePanel() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [connected, setConnected] = useState(false);
  const [toolCount, setToolCount] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [records, setRecords] = useState([]);
  const recordsRef = useRef([]);

  // Load saved URL and status on mount
  useEffect(() => {
    chrome.storage.local.get({ wsServerUrl: DEFAULT_URL }).then(({ wsServerUrl }) => {
      if (wsServerUrl) setUrl(wsServerUrl);
    });
    // Query current connection status
    chrome.runtime.sendMessage({ type: "wsbridge", action: "status" }, (res) => {
      if (res?.connected) {
        setConnected(true);
        setToolCount(res.tools || 0);
        setError(null);
      }
    });
  }, []);

  // Listen for status updates and tool call records
  useEffect(() => {
    function handleMessage(msg) {
      if (msg?.type === "wsbridge_status") {
        const { connected: isConnected, tools, error: err } = msg.status;
        setConnected(isConnected);
        setToolCount(tools || 0);
        setError(err || null);
        setConnecting(false);
      }
      if (msg?.type === "wsbridge_tool_call") {
        const next = [...recordsRef.current, msg.record];
        if (next.length > MAX_RECORDS) {
          next.splice(0, next.length - MAX_RECORDS);
        }
        recordsRef.current = next;
        setRecords(next);
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  const handleConnect = useCallback(() => {
    if (connected) {
      chrome.runtime.sendMessage({ type: "wsbridge", action: "disconnect" });
      setConnected(false);
      setToolCount(0);
    } else {
      setConnecting(true);
      setError(null);
      chrome.runtime.sendMessage({ type: "wsbridge", action: "connect", url });
    }
  }, [url, connected]);

  const statusDot = connected ? "🟢" : connecting ? "🟡" : "⚫";
  const statusText = connected
    ? `已连接 · ${toolCount} 个工具`
    : connecting
    ? "连接中..."
    : "未连接";
  const statusClass = connected
    ? "bridge-status-connected"
    : connecting
    ? "bridge-status-connecting"
    : "";

  return (
    <div className="bridge-panel">
      <div className="bridge-config-bar">
        <div className="bridge-url-wrap">
          <Input
            label=""
            inputClassName="!min-h-8 !text-sm"
            defaultValue={url}
            onChange={setUrl}
            placeholder={DEFAULT_URL}
          />
        </div>
        <Button
          className="!text-sm !min-h-8 !px-3 bridge-connect-btn"
          onPress={handleConnect}
          isDisabled={connecting}
        >
          {connecting ? "连接中..." : connected ? "断开" : "连接"}
        </Button>
        <span className={`bridge-status ${statusClass}`}>
          {statusDot} {statusText}
          {error && <span className="bridge-error"> — {error}</span>}
        </span>
      </div>

      <div className="bridge-records">
        {records.length === 0 ? (
          <div className="bridge-records-empty">暂无调用记录</div>
        ) : (
          records.slice().reverse().map((rec, i) => (
            <BridgeRecord key={rec.time + "-" + i} record={rec} />
          ))
        )}
      </div>
    </div>
  );
}

function BridgeRecord({ record }) {
  const { time, toolName, args, result, isError, duration } = record;
  const [expanded, setExpanded] = useState(false);
  const timeStr = new Date(time).toLocaleTimeString("zh-CN", { hour12: false });

  const detail = formatToolDetail(args);
  const resultPreview = typeof result === "string" ? result : JSON.stringify(result);
  const truncated = resultPreview.length > 120
    ? resultPreview.slice(0, 120) + "..."
    : resultPreview;

  return (
    <div
      className={`tool-result-msg ${isError ? "tool-result-error" : ""}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="tool-result-header">
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">
          {isError ? "❌" : "✅"} {timeStr} · 🔧 {toolName}({detail})
        </span>
        <span className="bridge-record-duration">{duration}ms</span>
      </div>
      {expanded && (
        <div>
          <pre className="tool-result-content">
            {"Args: " + JSON.stringify(args, null, 2) + "\n\nResult: " + resultPreview}
          </pre>
        </div>
      )}
    </div>
  );
}

function formatToolDetail(args) {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return "";
  if (args.tabId) return `Tab ${args.tabId}`;
  if (args.tabIds) return `${args.tabIds.length} tabs`;
  if (args.url) return args.url.length > 50 ? args.url.slice(0, 50) + "..." : args.url;
  if (args.query) return args.query.length > 30 ? args.query.slice(0, 30) + "..." : args.query;
  const keys = Object.keys(args).slice(0, 2);
  return keys.map(k => args[k]).join(", ").slice(0, 40);
}
