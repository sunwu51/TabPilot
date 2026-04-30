/* global chrome */
import { TOOLS, executeTool } from "./llm";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TOOL_CALL_TIMEOUT_MS = 60000;
const WS_STORAGE_KEY = "wsServerUrl";
const WS_PING_INTERVAL_MS = 30000;

let rpcId = 0;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let pingTimer = null;
let running = false;
let currentUrl = "";
let executionQueue = Promise.resolve();
let toolCount = 0;
let connectError = null;

function logWsBridge(message, data) {
  if (data === undefined) {
    console.debug(`[wsBridge] ${message}`);
  } else {
    console.debug(`[wsBridge] ${message}`, data);
  }
}

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
  logWsBridge("connect requested", { url });
  connect(url);
  notifyStatus({ connected: false, url, tools: 0 });
}

/**
 * Disconnect and stop reconnection.
 */
export function disconnectWsBridge() {
  running = false;
  logWsBridge("disconnect requested", { url: currentUrl });
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
  logWsBridge("disconnecting current socket/timers", {
    hasSocket: Boolean(socket),
    socketReadyState: socket?.readyState,
    hasReconnectTimer: Boolean(reconnectTimer),
    hasPingTimer: Boolean(pingTimer)
  });
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
}

function connect(url) {
  logWsBridge("connect attempt starting", {
    url,
    previousSocketReadyState: socket?.readyState,
    reconnectDelay
  });
  disconnect();
  toolCount = 0;
  connectError = null;

  try {
    socket = new WebSocket(url);
    logWsBridge("WebSocket object created", { url, readyState: socket.readyState });
  } catch (e) {
    connectError = e.message;
    console.warn("[wsBridge] WebSocket constructor failed", { url, error: e });
    notifyStatus({ connected: false, url: currentUrl, tools: 0, error: e.message });
    scheduleReconnect();
    return;
  }

  socket.onopen = (event) => {
    logWsBridge("WebSocket open", {
      url,
      readyState: socket?.readyState,
      eventType: event?.type
    });
    reconnectDelay = RECONNECT_BASE_MS;
    executionQueue = Promise.resolve();
    connectError = null;
    notifyStatus({ connected: true, url: currentUrl, tools: 0 });
  };

  socket.onmessage = (event) => {
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

  socket.onclose = (event) => {
    console.warn("[wsBridge] WebSocket closed", {
      url,
      code: event?.code,
      reason: event?.reason,
      wasClean: event?.wasClean,
      running,
      reconnectDelay,
      currentUrl,
      readyState: socket?.readyState,
      connectError
    });
    socket = null;
    toolCount = 0;
    notifyStatus({ connected: false, url: currentUrl, tools: 0, error: connectError });
    if (running) scheduleReconnect();
  };

  socket.onerror = (event) => {
    connectError = "WebSocket error";
    console.warn("[wsBridge] WebSocket error", {
      url,
      readyState: socket?.readyState,
      eventType: event?.type,
      event
    });
    socket?.close();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!running) return;
  const delayMs = reconnectDelay;
  logWsBridge("scheduling reconnect", {
    url: currentUrl,
    delayMs,
    nextDelayMs: Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  });
  reconnectTimer = setTimeout(() => {
    logWsBridge("reconnect timer fired", {
      url: currentUrl,
      delayMs,
      running
    });
    if (currentUrl) connect(currentUrl);
  }, delayMs);
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
