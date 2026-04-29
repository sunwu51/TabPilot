/* global chrome */
import { TOOLS, executeTool } from "./llm";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TOOL_CALL_TIMEOUT_MS = 60000;
const IDLE_TIMEOUT_MS = 30000;
const WS_STORAGE_KEY = "wsServerUrl";

let rpcId = 0;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let idleTimer = null;
let running = false;
let currentUrl = "";
let executionQueue = Promise.resolve();
let toolCount = 0;
let connectError = null;

/**
 * Connect to a WS server. Saves the URL to storage.
 * @param {string} url
 */
export async function connectWsBridge(url) {
  if (!url || (!url.startsWith("ws://") && !url.startsWith("wss://"))) {
    notifyStatus({ connected: false, error: "URL must start with ws:// or wss://" });
    return;
  }
  currentUrl = url;
  connectError = null;
  await chrome.storage.local.set({ [WS_STORAGE_KEY]: url });
  running = true;
  connect(url);
  notifyStatus({ connected: false, url, tools: 0 });
}

/**
 * Disconnect and stop reconnection.
 */
export function disconnectWsBridge() {
  running = false;
  disconnect();
  notifyStatus({ connected: false, url: "", tools: 0 });
}

/**
 * Get current connection status.
 */
export function getWsBridgeStatus() {
  return {
    connected: socket !== null && socket.readyState === WebSocket.OPEN,
    url: currentUrl,
    tools: toolCount,
    error: connectError
  };
}

function notifyStatus(status) {
  chrome.runtime.sendMessage({ type: "wsbridge_status", status }).catch(() => {});
}

function notifyToolCall(record) {
  chrome.runtime.sendMessage({ type: "wsbridge_tool_call", record }).catch(() => {});
}

function disconnect() {
  clearTimeout(reconnectTimer);
  clearTimeout(idleTimer);
  reconnectTimer = null;
  idleTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
}

function connect(url) {
  disconnect();
  toolCount = 0;
  connectError = null;

  try {
    socket = new WebSocket(url);
  } catch (e) {
    connectError = e.message;
    notifyStatus({ connected: false, url: currentUrl, tools: 0, error: e.message });
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    executionQueue = Promise.resolve();
    connectError = null;
    resetIdleWatchdog();
    notifyStatus({ connected: true, url: currentUrl, tools: 0 });
  };

  socket.onmessage = (event) => {
    resetIdleWatchdog();
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || msg.jsonrpc !== "2.0") return;

    if (msg.id != null && msg.method) {
      handleRequest(msg);
    }
  };

  socket.onclose = () => {
    socket = null;
    toolCount = 0;
    notifyStatus({ connected: false, url: currentUrl, tools: 0, error: connectError });
    if (running) scheduleReconnect();
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function resetIdleWatchdog() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }, IDLE_TIMEOUT_MS);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!running) return;
  reconnectTimer = setTimeout(() => {
    if (currentUrl) connect(currentUrl);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "TabManager", version: "1.4" },
        capabilities: { tools: {} }
      });
      break;

    case "tools/list":
      toolCount = TOOLS.length;
      sendResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.schema
        }))
      });
      notifyStatus({ connected: true, url: currentUrl, tools: toolCount });
      break;

    case "tools/call": {
      if (!params || typeof params.name !== "string") {
        sendError(id, -32602, "Invalid params: name is required");
        return;
      }
      executionQueue = executionQueue.then(() => executeToolCall(id, params));
      break;
    }

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

async function executeToolCall(id, params) {
  const { name, arguments: args = {} } = params;
  const startTime = Date.now();
  let result;
  let isError = false;

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tool execution timed out")), TOOL_CALL_TIMEOUT_MS)
    );
    result = await Promise.race([executeTool(name, args, []), timeoutPromise]);
  } catch (e) {
    isError = true;
    result = { error: e.message };
  }

  if (result && typeof result === "object" && !Array.isArray(result) && result.error) {
    isError = true;
  }

  const duration = Date.now() - startTime;
  notifyToolCall({
    time: Date.now(),
    toolName: name,
    args,
    result,
    isError,
    duration
  });

  if (isError) {
    sendError(id, -32603, result?.error || "Tool execution failed");
  } else {
    sendResponse(id, {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }]
    });
  }
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}
