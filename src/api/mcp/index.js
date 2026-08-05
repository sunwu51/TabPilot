/* global chrome */
import { buildOAuthHeaders } from "./oauth";
let _rpcId = 0;
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60000;
const MCP_SESSION_ID_HEADER = "Mcp-Session-Id";
const _sessionIds = new Map();
const EXTENSION_PROTOCOL_VERSION = "2025-03-26";

function _normalizeEndpoint(endpointOrUrl, headers = {}) {
  if (endpointOrUrl && typeof endpointOrUrl === "object") {
    if (endpointOrUrl.type === "extension") {
      return {
        type: "extension",
        extensionId: String(endpointOrUrl.extensionId || "").trim(),
        name: endpointOrUrl.name || ""
      };
    }
    return {
      type: "http",
      url: String(endpointOrUrl.url || "").trim(),
      headers: endpointOrUrl.headers || headers || {}
    };
  }
  return {
    type: "http",
    url: String(endpointOrUrl || "").trim(),
    headers: headers || {}
  };
}

function _sessionKey(url, headers = {}) {
  return JSON.stringify({ url, headers: _normalizeHeadersForSessionKey(headers) });
}

function _normalizeHeadersForSessionKey(headers = {}) {
  return Object.keys(headers || {})
    .sort()
    .reduce((result, key) => {
      result[key] = headers[key];
      return result;
    }, {});
}

function _getSessionIdFromResponse(res) {
  return res.headers.get(MCP_SESSION_ID_HEADER) || res.headers.get(MCP_SESSION_ID_HEADER.toLowerCase()) || "";
}

function _buildRequestHeaders(headers = {}, sessionId = "") {
  const requestHeaders = { ...(headers || {}) };
  if (sessionId) {
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === MCP_SESSION_ID_HEADER.toLowerCase()) {
        delete requestHeaders[key];
      }
    }
  }
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...requestHeaders,
    ...(sessionId ? { [MCP_SESSION_ID_HEADER]: sessionId } : {})
  };
}

/**
 * Send a JSON-RPC 2.0 request to an MCP server via Streamable HTTP.
 * Handles both JSON and SSE response content types.
 * @param {string} url - MCP server endpoint
 * @param {Object} headers - custom headers (e.g. Authorization)
 * @param {string} method - JSON-RPC method (e.g. "tools/list")
 * @param {Object} [params] - method parameters
 * @returns {Promise<Object>} JSON-RPC result
 */
async function rpcCall(url, headers, method, params, timeoutMs, options = {}) {
  const sessionKey = _sessionKey(url, headers);
  const initialSessionId = method === "initialize" ? "" : (_sessionIds.get(sessionKey) || "");
  try {
    return await _rpcCallOnce(url, headers, method, params, timeoutMs, initialSessionId, sessionKey);
  } catch (error) {
    if (!initialSessionId || error?.status !== 404 || options.skipSessionRefresh) {
      throw error;
    }

    _sessionIds.delete(sessionKey);
    await initializeMcp(url, headers, { skipSessionRefresh: true });
    const refreshedSessionId = _sessionIds.get(sessionKey) || "";
    return await _rpcCallOnce(url, headers, method, params, timeoutMs, refreshedSessionId, sessionKey);
  }
}

function _sendExtensionMessage(extensionId, message, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    const timerId = effectiveTimeoutMs > 0
      ? setTimeout(() => {
        if (finished) return;
        finished = true;
        reject(new Error(`MCP extension request timed out after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs)
      : null;

    try {
      chrome.runtime.sendMessage(extensionId, message, (response) => {
        if (finished) return;
        finished = true;
        if (timerId) clearTimeout(timerId);
        const runtimeError = chrome.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || String(runtimeError)));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      if (timerId) clearTimeout(timerId);
      reject(error);
    }
  });
}

function _requestOAuthFromServiceWorker(serverUrl, wwwAuthenticate, action = "authorize") {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "mcp_oauth", action, serverUrl, wwwAuthenticate }, response => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) reject(new Error(runtimeError.message));
      else if (!response?.success) reject(new Error(response?.error || "OAuth authorization failed"));
      else resolve(response.token);
    });
  });
}

async function _rpcCallExtension(extensionId, method, params, timeoutMs) {
  const id = ++_rpcId;
  const response = await _sendExtensionMessage(extensionId, {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {})
  }, timeoutMs);
  if (!response || typeof response !== "object") {
    throw new Error("Extension MCP returned an invalid response");
  }
  if (response.error) {
    throw new Error(`MCP RPC error: ${response.error.message || JSON.stringify(response.error)}`);
  }
  return response.result;
}

async function _rpcCallOnce(url, headers, method, params, timeoutMs, sessionId = "", sessionKey = _sessionKey(url, headers)) {
  const id = ++_rpcId;
  const body = {
    jsonrpc: "2.0",
    method,
    id,
    ...(params !== undefined ? { params } : {})
  };

  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  let timerId = null;
  if (effectiveTimeoutMs > 0) {
    timerId = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: _buildRequestHeaders(headers, sessionId),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    if (timerId) clearTimeout(timerId);
    if (e.name === "AbortError") {
      throw new Error(`MCP request timed out after ${effectiveTimeoutMs}ms`);
    }
    throw e;
  }

  if (timerId) clearTimeout(timerId);

  if (!res.ok) {
    const errText = await res.text();
    const error = new Error(`MCP error ${res.status}: ${errText}`);
    error.status = res.status;
    error.wwwAuthenticate = res.headers.get("WWW-Authenticate") || res.headers.get("www-authenticate") || "";
    throw error;
  }

  const responseSessionId = _getSessionIdFromResponse(res);
  if (method === "initialize" && responseSessionId) {
    _sessionIds.set(sessionKey, responseSessionId);
  }

  const contentType = res.headers.get("content-type") || "";

  // SSE response — collect all data events and parse the final result
  if (contentType.includes("text/event-stream")) {
    return _parseSSEResponse(res);
  }

  // Standard JSON response
  const json = await res.json();
  if (json.error) {
    throw new Error(`MCP RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

/**
 * Parse an SSE stream response from MCP server.
 * Collects all "data:" lines and returns the last JSON-RPC result.
 */
async function _parseSSEResponse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastResult = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          if (json.result !== undefined) lastResult = json.result;
          if (json.error) throw new Error(`MCP RPC error: ${json.error.message || JSON.stringify(json.error)}`);
        } catch (e) {
          if (e.message.startsWith("MCP RPC error")) throw e;
          // skip malformed JSON
        }
      }
    }
  }

  if (lastResult === null) throw new Error("MCP SSE response contained no result");
  return lastResult;
}

/**
 * Initialize connection to an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @returns {Promise<{serverInfo: Object, capabilities: Object}>}
 */
export async function initializeMcp(url, headers = {}, options = {}) {
  const endpoint = _normalizeEndpoint(url, headers);
  if (endpoint.type === "extension") {
    return await _rpcCallExtension(endpoint.extensionId, "initialize", {
      protocolVersion: EXTENSION_PROTOCOL_VERSION
    });
  }
  _sessionIds.delete(_sessionKey(endpoint.url, endpoint.headers));
  const result = await rpcCall(endpoint.url, endpoint.headers, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "TabPilot",
      version: "1.0"
    }
  }, undefined, options);
  return result;
}

/**
 * Fetch available tools from an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @returns {Promise<Array<{name: string, description: string, inputSchema: Object}>>}
 */
export async function listMcpTools(url, headers = {}) {
  const endpoint = _normalizeEndpoint(url, headers);
  if (endpoint.type === "extension") {
    const result = await _rpcCallExtension(endpoint.extensionId, "tools/list");
    return result.tools || [];
  }
  const result = await rpcCall(endpoint.url, endpoint.headers, "tools/list");
  return result.tools || [];
}

/**
 * Fetch available resources from an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @returns {Promise<Array<{name: string, uri: string, description?: string, mimeType?: string}>>}
 */
export async function listMcpResources(url, headers = {}) {
  const endpoint = _normalizeEndpoint(url, headers);
  if (endpoint.type === "extension") {
    const result = await _rpcCallExtension(endpoint.extensionId, "resources/list");
    return result.resources || [];
  }
  const result = await rpcCall(endpoint.url, endpoint.headers, "resources/list");
  return result.resources || [];
}

/**
 * Read a resource from an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @param {string} uri - resource URI
 * @returns {Promise<Object>} raw MCP resource read result
 */
export async function readMcpResource(url, headers = {}, uri) {
  const endpoint = _normalizeEndpoint(url, headers);
  if (endpoint.type === "extension") {
    return await _rpcCallExtension(endpoint.extensionId, "resources/read", { uri });
  }
  return await rpcCall(endpoint.url, endpoint.headers, "resources/read", { uri });
}

/**
 * Call a tool on an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @param {string} toolName - tool name
 * @param {Object} args - tool arguments
 * @returns {Promise<Object>} tool result
 */
export async function callMcpTool(url, headers = {}, toolName, args, timeoutMs = DEFAULT_MCP_TOOL_TIMEOUT_MS) {
  const endpoint = _normalizeEndpoint(url, headers);
  if (endpoint.type === "extension") {
    const result = await _rpcCallExtension(endpoint.extensionId, "tools/call", {
      name: toolName,
      arguments: args
    }, timeoutMs);
    if (result.content && Array.isArray(result.content)) {
      const texts = result.content
        .filter(c => c.type === "text")
        .map(c => c.text);
      if (texts.length === 1) return { result: texts[0] };
      if (texts.length > 1) return { result: texts.join("\n") };
    }
    return result;
  }
  const result = await rpcCall(endpoint.url, endpoint.headers, "tools/call", {
    name: toolName,
    arguments: args
  }, timeoutMs);

  // MCP returns { content: [{ type: "text", text: "..." }] }
  // Flatten to a simple string or object for LLM consumption
  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter(c => c.type === "text")
      .map(c => c.text);
    if (texts.length === 1) return { result: texts[0] };
    if (texts.length > 1) return { result: texts.join("\n") };
  }
  return result;
}

/**
 * Connect to an MCP server: initialize + list tools.
 * Returns server info and tool list, or error.
 * @param {string} url
 * @param {Object} headers
 * @returns {Promise<{name: string, tools: Array, error?: string}>}
 */
export async function connectMcpServer(url, headers = {}) {
  const endpoint = _normalizeEndpoint(url, headers);
  try {
    const info = await initializeMcp(endpoint, endpoint.headers || {});
    const tools = await listMcpTools(endpoint, endpoint.headers || {});
    return {
      name: info.serverInfo?.name || "MCP Server",
      tools,
      error: null
    };
  } catch (e) {
    if (endpoint.type === "http" && e?.status === 401) {
      try {
        let token;
        if (endpoint.headers?.Authorization) {
          try { token = await _requestOAuthFromServiceWorker(endpoint.url, e.wwwAuthenticate, "refresh"); } catch (_) { /* fall through to full authorization */ }
        }
        if (!token) token = await _requestOAuthFromServiceWorker(endpoint.url, e.wwwAuthenticate, "authorize");
        const authorizedHeaders = buildOAuthHeaders(endpoint.headers, token);
        const info = await initializeMcp(endpoint.url, authorizedHeaders);
        const tools = await listMcpTools(endpoint.url, authorizedHeaders);
        return { name: info.serverInfo?.name || "MCP Server", tools, error: null, headers: authorizedHeaders };
      } catch (oauthError) {
        return { name: "MCP Server", tools: [], error: `OAuth 授权失败: ${oauthError.message}` };
      }
    }
    return {
      name: "MCP Server",
      tools: [],
      error: e.message
    };
  }
}
