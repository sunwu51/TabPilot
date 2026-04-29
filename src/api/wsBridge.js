/* global chrome */
import { TOOLS, executeTool } from "./llm";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TOOL_CALL_TIMEOUT_MS = 60000;
const WS_STORAGE_KEY = "wsServerUrl";

let rpcId = 0;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let running = false;
let executionQueue = Promise.resolve();

/**
 * Start the WebSocket MCP bridge.
 * Reads the configured WS server URL from storage and connects.
 * Reconnects automatically on disconnect with exponential backoff.
 */
export async function startWsBridge() {
  running = true;
  const { [WS_STORAGE_KEY]: url } = await chrome.storage.local.get({ [WS_STORAGE_KEY]: "" });
  if (!url) return;
  connect(url);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(WS_STORAGE_KEY in changes)) return;
    const newUrl = changes[WS_STORAGE_KEY].newValue || "";
    const oldUrl = changes[WS_STORAGE_KEY].oldValue || "";
    if (newUrl !== oldUrl) {
      reconnectDelay = RECONNECT_BASE_MS;
      if (newUrl) connect(newUrl);
      else disconnect();
    }
  });
}

/**
 * Stop the bridge and cancel any pending reconnect.
 */
export function stopWsBridge() {
  running = false;
  disconnect();
}

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
}

function connect(url) {
  if (!url || !url.startsWith("wss://")) {
    console.warn("[wsBridge] Refusing to connect: URL must start with wss://");
    return;
  }

  disconnect();

  try {
    socket = new WebSocket(url);
  } catch (e) {
    console.error("[wsBridge] WebSocket creation failed:", e.message);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    executionQueue = Promise.resolve();
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
    // notifications (no id) — silently ack if needed
  };

  socket.onclose = () => {
    socket = null;
    if (running) scheduleReconnect();
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!running) return;
  reconnectTimer = setTimeout(async () => {
    const { [WS_STORAGE_KEY]: url } = await chrome.storage.local.get({ [WS_STORAGE_KEY]: "" });
    if (url) connect(url);
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
      sendResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.schema
        }))
      });
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

  let result;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tool execution timed out")), TOOL_CALL_TIMEOUT_MS)
    );
    result = await Promise.race([executeTool(name, args, []), timeoutPromise]);
  } catch (e) {
    sendError(id, -32603, e.message || "Tool execution failed");
    return;
  }

  if (result && typeof result === "object" && !Array.isArray(result) && result.error) {
    sendError(id, -32603, result.error);
    return;
  }

  sendResponse(id, {
    content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }]
  });
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
