/* global chrome */
import { TOOLS, executeTool, isImageToolName } from "./llm";
import { isImageApiConfigured } from "./llm/builtins/imageApi";
import { DEFAULT_WS_BRIDGE_STATUS, WS_BRIDGE_STATUS_STORAGE_KEY } from "./wsBridgeShared";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TOOL_CALL_TIMEOUT_MS = 60000;
const WS_STORAGE_KEY = "wsServerUrl";
const BRIDGE_ENABLED_STORAGE_KEY = "bridgeEnabled";
const WS_BRIDGE_STALE_HEARTBEAT_MS = 90000;
const WS_BRIDGE_CONNECTING_GRACE_MS = 45000;

let socket = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let running = false;
let currentUrl = "";
let configuredUrl = "";
let executionQueue = Promise.resolve();
let toolCount = 0;
let connectError = null;
let disconnectReason = "";
let bridgeEnabled = false;
let wsBridgeStatus = { ...DEFAULT_WS_BRIDGE_STATUS };
let storageListenerRegistered = false;

function logWsBridge(message, data) {
  if (data === undefined) {
    console.debug(`[wsBridge] ${message}`);
  } else {
    console.debug(`[wsBridge] ${message}`, data);
  }
}

/**
 * Start the WebSocket MCP bridge based on persisted settings.
 */
export async function startWsBridge() {
  ensureStorageListener();
  const {
    [WS_STORAGE_KEY]: url,
    [BRIDGE_ENABLED_STORAGE_KEY]: enabled
  } = await chrome.storage.local.get({
    [WS_STORAGE_KEY]: "",
    [BRIDGE_ENABLED_STORAGE_KEY]: false
  });
  await syncConfiguredBridge(url, enabled === true);
}

/**
 * Connect to a WS server. Saves the URL to storage.
 * @param {string} url
 */
export async function connectWsBridge(url) {
  const normalizedUrl = normalizeWsUrl(url);
  if (!normalizedUrl) {
    connectError = "URL must start with ws:// or wss://";
    updateBridgeStatus({
      state: "error",
      url: currentUrl || configuredUrl || "",
      error: connectError,
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0
    }, {
      connected: false,
      url: currentUrl || configuredUrl || "",
      tools: toolCount,
      error: connectError
    });
    return;
  }

  running = true;
  connectError = null;
  configuredUrl = normalizedUrl;
  currentUrl = normalizedUrl;
  reconnectDelay = RECONNECT_BASE_MS;
  logWsBridge("connect requested", { url: normalizedUrl });
  connect(normalizedUrl);
}

/**
 * Disconnect and stop reconnection for the current session.
 */
export function disconnectWsBridge() {
  running = false;
  disconnectReason = "";
  logWsBridge("disconnect requested", { url: currentUrl || configuredUrl });
  disconnect();
  currentUrl = "";
  connectError = null;
  toolCount = 0;
  updateBridgeStatus({
    state: bridgeEnabled ? "disconnected" : "disabled",
    url: "",
    error: "",
    connectedAt: 0,
    lastHeartbeatAt: 0,
    lastHeartbeatAckAt: 0,
    tools: 0
  }, {
    connected: false,
    url: "",
    tools: 0,
    error: null
  });
}

/**
 * Get current connection status for BridgePanel.
 */
export function getWsBridgeStatus() {
  return {
    connected: socket !== null && socket.readyState === WebSocket.OPEN,
    url: currentUrl || configuredUrl || "",
    tools: toolCount,
    error: connectError
  };
}

/**
 * Reconnect after worker wake-up if the bridge should be alive but heartbeat is stale.
 */
export async function ensureWsBridgeHealthy() {
  const {
    [WS_STORAGE_KEY]: storedUrl,
    [BRIDGE_ENABLED_STORAGE_KEY]: storedEnabled,
    [WS_BRIDGE_STATUS_STORAGE_KEY]: storedStatus
  } = await chrome.storage.local.get({
    [WS_STORAGE_KEY]: configuredUrl || "",
    [BRIDGE_ENABLED_STORAGE_KEY]: bridgeEnabled,
    [WS_BRIDGE_STATUS_STORAGE_KEY]: wsBridgeStatus
  });

  configuredUrl = typeof storedUrl === "string" ? storedUrl.trim() : "";
  bridgeEnabled = storedEnabled === true;
  if (!bridgeEnabled || !configuredUrl || !running) {
    return false;
  }

  wsBridgeStatus = {
    ...DEFAULT_WS_BRIDGE_STATUS,
    ...wsBridgeStatus,
    ...(storedStatus || {})
  };

  const socketState = socket ? socket.readyState : WebSocket.CLOSED;
  const now = Date.now();
  const hasHeartbeat = Number.isFinite(wsBridgeStatus.lastHeartbeatAckAt) && wsBridgeStatus.lastHeartbeatAckAt > 0;
  const heartbeatAge = hasHeartbeat ? now - wsBridgeStatus.lastHeartbeatAckAt : 0;
  const statusAge = Number.isFinite(wsBridgeStatus.updatedAt) && wsBridgeStatus.updatedAt > 0
    ? now - wsBridgeStatus.updatedAt
    : Number.POSITIVE_INFINITY;
  const statusLooksConnecting = (wsBridgeStatus.state === "connecting" || wsBridgeStatus.state === "reconnecting")
    && statusAge <= WS_BRIDGE_CONNECTING_GRACE_MS;

  if (socketState === WebSocket.OPEN && (!hasHeartbeat || heartbeatAge <= WS_BRIDGE_STALE_HEARTBEAT_MS)) {
    return false;
  }
  if (socketState === WebSocket.CONNECTING || statusLooksConnecting) {
    return false;
  }

  reconnectDelay = RECONNECT_BASE_MS;
  connect(configuredUrl, { isReconnect: true });
  return true;
}

function ensureStorageListener() {
  if (storageListenerRegistered) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!(WS_STORAGE_KEY in changes) && !(BRIDGE_ENABLED_STORAGE_KEY in changes)) return;
    reconnectDelay = RECONNECT_BASE_MS;
    const nextUrl = WS_STORAGE_KEY in changes ? changes[WS_STORAGE_KEY].newValue || "" : configuredUrl;
    const nextEnabled = BRIDGE_ENABLED_STORAGE_KEY in changes ? changes[BRIDGE_ENABLED_STORAGE_KEY].newValue === true : bridgeEnabled;
    void syncConfiguredBridge(nextUrl, nextEnabled);
  });
  storageListenerRegistered = true;
}

async function syncConfiguredBridge(url, enabled) {
  configuredUrl = typeof url === "string" ? url.trim() : "";
  bridgeEnabled = enabled === true;

  if (!bridgeEnabled) {
    running = false;
    currentUrl = "";
    connectError = null;
    toolCount = 0;
    disconnect();
    updateBridgeStatus({
      state: "disabled",
      url: "",
      error: "",
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: false,
      url: "",
      tools: 0,
      error: null
    });
    return;
  }

  if (!configuredUrl) {
    running = false;
    currentUrl = "";
    connectError = null;
    toolCount = 0;
    disconnect();
    updateBridgeStatus({
      state: "idle",
      url: "",
      error: "",
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: false,
      url: "",
      tools: 0,
      error: null
    });
    return;
  }

  running = true;
  const normalizedUrl = normalizeWsUrl(configuredUrl);
  if (!normalizedUrl) {
    currentUrl = "";
    connectError = "WS Server 地址必须是合法的 ws:// 或 wss:// URL";
    disconnect();
    updateBridgeStatus({
      state: "error",
      url: configuredUrl,
      error: connectError,
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: false,
      url: configuredUrl,
      tools: 0,
      error: connectError
    });
    return;
  }

  if (normalizedUrl === currentUrl) {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }
    if (reconnectTimer) return;
  }

  connect(normalizedUrl);
}

function disconnect() {
  logWsBridge("disconnecting current socket/timers", {
    hasSocket: Boolean(socket),
    socketReadyState: socket?.readyState,
    hasReconnectTimer: Boolean(reconnectTimer)
  });
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    socket.close();
    socket = null;
  }
}

function connect(url, { isReconnect = false } = {}) {
  const normalizedUrl = normalizeWsUrl(url);
  logWsBridge("connect attempt starting", {
    url,
    normalizedUrl,
    previousSocketReadyState: socket?.readyState,
    reconnectDelay,
    isReconnect
  });

  disconnect();
  toolCount = 0;
  connectError = null;
  disconnectReason = "";

  if (!normalizedUrl) {
    currentUrl = typeof url === "string" ? url.trim() : "";
    connectError = "URL must start with ws:// or wss://";
    updateBridgeStatus({
      state: "error",
      url: currentUrl,
      error: connectError,
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: false,
      url: currentUrl,
      tools: 0,
      error: connectError
    });
    return;
  }

  currentUrl = normalizedUrl;
  updateBridgeStatus({
    state: isReconnect ? "reconnecting" : "connecting",
    url: normalizedUrl,
    error: "",
    connectedAt: 0,
    lastHeartbeatAt: 0,
    lastHeartbeatAckAt: 0,
    tools: 0
  }, {
    connected: false,
    url: normalizedUrl,
    tools: 0,
    error: null
  });

  let nextSocket;
  try {
    nextSocket = new WebSocket(normalizedUrl);
    socket = nextSocket;
    logWsBridge("WebSocket object created", { url: normalizedUrl, readyState: nextSocket.readyState });
  } catch (e) {
    connectError = e.message || String(e);
    updateBridgeStatus({
      state: "error",
      url: normalizedUrl,
      error: connectError,
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: false,
      url: normalizedUrl,
      tools: 0,
      error: connectError
    });
    scheduleReconnect();
    return;
  }

  nextSocket.onopen = () => {
    if (socket !== nextSocket) return;
    logWsBridge("WebSocket open", { url: normalizedUrl, readyState: nextSocket.readyState });
    reconnectDelay = RECONNECT_BASE_MS;
    executionQueue = Promise.resolve();
    connectError = null;
    updateBridgeStatus({
      state: "connected",
      url: normalizedUrl,
      error: "",
      connectedAt: Date.now(),
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: true,
      url: normalizedUrl,
      tools: toolCount,
      error: null
    });
  };

  nextSocket.onmessage = (event) => {
    if (socket !== nextSocket) return;
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

  nextSocket.onclose = (event) => {
    if (socket !== nextSocket) return;
    logWsBridge("WebSocket closed", {
      url: normalizedUrl,
      code: event?.code,
      reason: event?.reason,
      wasClean: event?.wasClean,
      running,
      reconnectDelay,
      configuredUrl,
      connectError,
      disconnectReason
    });
    socket = null;
    toolCount = 0;
    const errorMessage = disconnectReason || connectError || "";
    disconnectReason = "";
    const shouldReconnect = running && bridgeEnabled && !!configuredUrl;
    updateBridgeStatus({
      state: shouldReconnect ? "reconnecting" : "disconnected",
      url: shouldReconnect ? configuredUrl : "",
      error: errorMessage,
      connectedAt: 0,
      lastHeartbeatAt: 0,
      lastHeartbeatAckAt: 0,
      tools: 0
    }, {
      connected: false,
      url: shouldReconnect ? configuredUrl : "",
      tools: 0,
      error: errorMessage || null
    });
    if (shouldReconnect) scheduleReconnect();
  };

  nextSocket.onerror = (event) => {
    connectError = "WebSocket error";
    disconnectReason = disconnectReason || connectError;
    console.warn("[wsBridge] WebSocket error", {
      url: normalizedUrl,
      readyState: nextSocket.readyState,
      eventType: event?.type,
      event
    });
    nextSocket.close();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!running || !bridgeEnabled || !configuredUrl) return;
  const delayMs = reconnectDelay;
  logWsBridge("scheduling reconnect", {
    url: configuredUrl,
    delayMs,
    nextDelayMs: Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  });
  reconnectTimer = setTimeout(() => {
    logWsBridge("reconnect timer fired", {
      url: configuredUrl,
      delayMs,
      running,
      bridgeEnabled
    });
    if (running && bridgeEnabled && configuredUrl) {
      connect(configuredUrl, { isReconnect: true });
    }
  }, delayMs);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case "ping": {
      const heartbeatAt = Date.now();
      sendResponse(id, {});
      updateBridgeStatus({
        state: "connected",
        url: currentUrl || configuredUrl,
        error: "",
        connectedAt: wsBridgeStatus.connectedAt || Date.now(),
        lastHeartbeatAt: heartbeatAt,
        lastHeartbeatAckAt: heartbeatAt,
        tools: toolCount
      }, {
        connected: true,
        url: currentUrl || configuredUrl,
        tools: toolCount,
        error: null
      });
      break;
    }

    case "initialize":
      sendResponse(id, {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "TabManager", version: "1.4" },
        capabilities: { tools: {} }
      });
      break;

    case "tools/list": {
      const tools = await getBridgeTools();
      toolCount = tools.length;
      sendResponse(id, {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.schema
        }))
      });
      updateBridgeStatus({
        state: "connected",
        url: currentUrl || configuredUrl,
        error: "",
        connectedAt: wsBridgeStatus.connectedAt || Date.now(),
        tools: toolCount
      }, {
        connected: true,
        url: currentUrl || configuredUrl,
        tools: toolCount,
        error: null
      });
      break;
    }

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

async function getBridgeTools() {
  const { llmConfig } = await chrome.storage.local.get({ llmConfig: {} });
  const imageToolsEnabled = isImageApiConfigured(llmConfig);
  return TOOLS.filter(tool => imageToolsEnabled || !isImageToolName(tool.name));
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

function notifyStatus(status) {
  chrome.runtime.sendMessage({ type: "wsbridge_status", status }).catch(() => {});
}

function notifyToolCall(record) {
  chrome.runtime.sendMessage({ type: "wsbridge_tool_call", record }).catch(() => {});
}

function updateBridgeStatus(statusPatch, bridgePatch = {}) {
  void persistStatus(statusPatch);
  notifyStatus({
    connected: socket !== null && socket.readyState === WebSocket.OPEN,
    url: currentUrl || configuredUrl || "",
    tools: toolCount,
    error: connectError,
    ...bridgePatch
  });
}

function normalizeWsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function persistStatus(patch) {
  wsBridgeStatus = {
    ...DEFAULT_WS_BRIDGE_STATUS,
    ...wsBridgeStatus,
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [WS_BRIDGE_STATUS_STORAGE_KEY]: wsBridgeStatus });
}
