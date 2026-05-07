/* global chrome */
import { Button } from "@sunwu51/camel-ui";
import { useEffect, useState, useRef, useCallback } from "react";
import {
  DEFAULT_WS_BRIDGE_STATUS,
  formatWsBridgeStatusTime,
  getWsBridgeStateMeta,
  WS_BRIDGE_STATUS_STORAGE_KEY
} from "../../api/wsBridgeShared";

const MAX_RECORDS = 100;

/**
 * "工具透出" tab — configure WebSocket bridge to expose built-in tools as MCP.
 * Shows connection status and tool call history.
 */
export default function BridgePanel() {
  const [url, setUrl] = useState("");
  const [wsBridgeStatus, setWsBridgeStatus] = useState(DEFAULT_WS_BRIDGE_STATUS);
  const [records, setRecords] = useState([]);
  const recordsRef = useRef([]);

  // Load saved URL and status on mount
  useEffect(() => {
    chrome.storage.local.get({
      wsServerUrl: "",
      [WS_BRIDGE_STATUS_STORAGE_KEY]: DEFAULT_WS_BRIDGE_STATUS
    }).then(({ wsServerUrl, [WS_BRIDGE_STATUS_STORAGE_KEY]: status }) => {
      setUrl(typeof wsServerUrl === "string" ? wsServerUrl : "");
      setWsBridgeStatus({
        ...DEFAULT_WS_BRIDGE_STATUS,
        ...(status || {})
      });
    });
  }, []);

  useEffect(() => {
    function handleStorageChange(changes, areaName) {
      if (areaName !== "local") return;
      if (changes.wsServerUrl) {
        setUrl(typeof changes.wsServerUrl.newValue === "string" ? changes.wsServerUrl.newValue : "");
      }
      if (changes[WS_BRIDGE_STATUS_STORAGE_KEY]) {
        setWsBridgeStatus({
          ...DEFAULT_WS_BRIDGE_STATUS,
          ...(changes[WS_BRIDGE_STATUS_STORAGE_KEY].newValue || {})
        });
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  useEffect(() => {
    function handleMessage(msg) {
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
    if (wsBridgeStatus.state === "connected" || wsBridgeStatus.state === "connecting" || wsBridgeStatus.state === "reconnecting") {
      chrome.runtime.sendMessage({ type: "wsbridge", action: "disconnect" });
    } else {
      chrome.runtime.sendMessage({ type: "wsbridge", action: "connect", url });
    }
  }, [url, wsBridgeStatus.state]);

  const wsBridgeStateMeta = getWsBridgeStateMeta(wsBridgeStatus.state);
  const connectedLike = wsBridgeStatus.state === "connected" || wsBridgeStatus.state === "connecting" || wsBridgeStatus.state === "reconnecting";
  const actionLabel = connectedLike ? "断开" : "连接";
  const heartbeatText = formatWsBridgeStatusTime(wsBridgeStatus.lastHeartbeatAckAt);

  return (
    <div className="bridge-panel">
      <div className="bridge-config-bar">
        <div className="bridge-status-block">
          <div className="bridge-status-line">
            <span className="bridge-status-label">Bridge 状态</span>
            <span className="bridge-status-pill" style={{ color: wsBridgeStateMeta.color }}>
              {wsBridgeStateMeta.label}
            </span>
            {wsBridgeStatus.tools > 0 ? <span className="bridge-status-meta">{wsBridgeStatus.tools} 个工具</span> : null}
            {heartbeatText ? <span className="bridge-status-meta">最近心跳 {heartbeatText}</span> : null}
          </div>
          <div className="bridge-status-url">
            {url || "请先在设置中填写 WS Server 地址"}
          </div>
          {wsBridgeStatus.error ? <div className="bridge-error">{wsBridgeStatus.error}</div> : null}
        </div>
        <Button
          className="!text-sm !min-h-8 !px-3 bridge-connect-btn"
          onPress={handleConnect}
          isDisabled={!url}
        >
          {actionLabel}
        </Button>
      </div>

      <div className="bridge-records">
        {records.length === 0 ? (
          <div className="bridge-records-empty">
            <span>
              该功能是将浏览器操作函数作为 MCP 能力透出给其他 agent（如 Claude Code）进行使用，需配合{" "}
              <a
                href="https://github.com/sunwu51/mcp-center"
                target="_blank"
                rel="noopener noreferrer"
                className="bridge-mcp-link"
              >
                mcp-center
              </a>
              {" "}项目使用。
            </span>
          </div>
        ) : (
          records.slice().reverse().map((rec, i) => (
            <BridgeRecord key={rec.time + "-" + i} record={rec} />
          ))
        )}
      </div>
    </div>
  );
}

/* eslint-disable react/prop-types */
function BridgeRecord({ record }) {
  const { time, toolName, args, result, isError, duration } = record;
  const [expanded, setExpanded] = useState(false);
  const timeStr = new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
  const dateStr = new Date(time).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });

  const detail = formatToolDetail(args);
  const resultPreview = typeof result === "string" ? result : JSON.stringify(result);

  return (
    <div
      className={`tool-result-msg ${isError ? "tool-result-error" : ""}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="tool-result-header">
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">
          {isError ? "❌" : "✅"} {dateStr} {timeStr} · 🔧 {toolName}({detail})
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
