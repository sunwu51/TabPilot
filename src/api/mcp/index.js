/* global chrome */
import { buildOAuthHeaders } from "./oauth";
let _rpcId = 0;
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60000;
const MCP_SESSION_ID_HEADER = "Mcp-Session-Id";

function normalizeMcpTextResult(texts) {
  let result = texts.length === 1 ? texts[0] : texts.join("\n");
  for (let depth = 0; depth < 3 && typeof result === "string" && result.trim(); depth += 1) {
    try {
      result = JSON.parse(result);
    } catch {
      break;
    }
  }
  return { result };
}
const _sessionIds = new Map();
const EXTENSION_PROTOCOL_VERSION = "2025-03-26";

// Per-conversation MCP sessions. A conversation that passes `conversationId` gets its own
// Mcp-Session-Id from each HTTP server (created on first use, persisted so it survives
// side-panel reloads and service-worker restarts), so stateful servers can keep one
// conversation's state apart from another's. Calls without a conversationId (tool discovery,
// settings) keep the legacy shared session.
const CONVERSATION_SESSIONS_KEY = "mcp_conversation_sessions";
const CONVERSATION_SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const CONVERSATION_SESSION_TOUCH_MS = 24 * 60 * 60 * 1000;
const SESSION_RENEWED_NOTICE = "The MCP server started a new session for this conversation because the previous one expired or was reset. State held by the old session (for example terminals or background jobs) may no longer be accessible.";
const _sessionNotices = new Map();
const _initInFlight = new Map();
let _storageQueue = Promise.resolve();

function _hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Identifies a server without storing its credentials: the URL plus a hash of the headers.
function _serverKey(url, headers = {}) {
  return `${url}#${_hashText(JSON.stringify(_normalizeHeadersForSessionKey(headers)))}`;
}

function _hasStorage() {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

async function _readStoredSessions() {
  if (!_hasStorage()) return {};
  try {
    const stored = await chrome.storage.local.get({ [CONVERSATION_SESSIONS_KEY]: {} });
    const all = stored[CONVERSATION_SESSIONS_KEY];
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

// Serialized read-modify-write; the mutator edits the whole map in place.
function _updateStoredSessions(mutator) {
  _storageQueue = _storageQueue.then(async () => {
    if (!_hasStorage()) return;
    try {
      const all = await _readStoredSessions();
      mutator(all);
      const cutoff = Date.now() - CONVERSATION_SESSION_MAX_AGE_MS;
      for (const [conversationId, servers] of Object.entries(all)) {
        for (const [serverKey, record] of Object.entries(servers || {})) {
          if (!(record?.updatedAt > cutoff)) delete servers[serverKey];
        }
        if (!servers || Object.keys(servers).length === 0) delete all[conversationId];
      }
      await chrome.storage.local.set({ [CONVERSATION_SESSIONS_KEY]: all });
    } catch {
      // Persistence is best effort; the in-memory session still works.
    }
  });
  return _storageQueue;
}

async function _initializeConversation(url, headers, conversationId, sessionKey) {
  let pending = _initInFlight.get(sessionKey);
  if (!pending) {
    pending = (async () => {
      await initializeMcp(url, headers, { conversationId, skipSessionRefresh: true });
      // A stateless server returns no session id; remember that so we do not initialize again.
      if (!_sessionIds.has(sessionKey)) _sessionIds.set(sessionKey, "");
      const id = _sessionIds.get(sessionKey) || "";
      const serverKey = _serverKey(url, headers);
      await _updateStoredSessions(all => {
        (all[conversationId] ||= {})[serverKey] = { id, updatedAt: Date.now() };
      });
    })().finally(() => _initInFlight.delete(sessionKey));
    _initInFlight.set(sessionKey, pending);
  }
  return pending;
}

async function _resolveConversationSessionId(url, headers, conversationId, sessionKey) {
  if (_sessionIds.has(sessionKey)) return _sessionIds.get(sessionKey);
  const serverKey = _serverKey(url, headers);
  const record = (await _readStoredSessions())[conversationId]?.[serverKey];
  if (typeof record?.id === "string") {
    _sessionIds.set(sessionKey, record.id);
    // Keep an actively used conversation from aging out of storage.
    if (Date.now() - (record.updatedAt || 0) > CONVERSATION_SESSION_TOUCH_MS) {
      void _updateStoredSessions(all => {
        const current = all[conversationId]?.[serverKey];
        if (current) current.updatedAt = Date.now();
      });
    }
    return record.id;
  }
  await _initializeConversation(url, headers, conversationId, sessionKey);
  return _sessionIds.get(sessionKey) || "";
}

/**
 * End a conversation's MCP sessions (call when the conversation is deleted) so servers can
 * release what the conversation owns. Servers no longer configured are forgotten locally;
 * their sessions end through the server's own inactivity expiry.
 * @param {string} conversationId
 * @param {Array} [registry] - MCP tool registry entries ({_serverUrl, _serverHeaders, _serverType})
 */
export async function releaseMcpConversation(conversationId, registry = []) {
  const id = String(conversationId || "").trim();
  if (!id) return;
  for (const key of [..._sessionIds.keys()]) {
    try { if (JSON.parse(key).conversationId === id) _sessionIds.delete(key); } catch { /* not ours */ }
  }
  const mine = (await _readStoredSessions())[id];
  if (!mine) return;
  const servers = new Map();
  for (const tool of registry || []) {
    if (!tool || tool._serverType === "extension" || !tool._serverUrl) continue;
    servers.set(_serverKey(tool._serverUrl, tool._serverHeaders || {}), tool);
  }
  await Promise.all([...servers].map(async ([serverKey, tool]) => {
    const record = mine[serverKey];
    if (!record?.id) return;
    try {
      await fetch(tool._serverUrl, {
        method: "DELETE",
        headers: _buildRequestHeaders(tool._serverHeaders || {}, record.id),
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      // The server expires idle sessions on its own.
    }
  }));
  await _updateStoredSessions(all => { delete all[id]; });
}

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

function _sessionKey(url, headers = {}, conversationId = "") {
  return JSON.stringify({
    url,
    headers: _normalizeHeadersForSessionKey(headers),
    ...(conversationId ? { conversationId } : {})
  });
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
  const conversationId = String(options.conversationId || "").trim();
  const sessionKey = _sessionKey(url, headers, conversationId);
  let initialSessionId = "";
  if (method !== "initialize") {
    initialSessionId = conversationId
      ? await _resolveConversationSessionId(url, headers, conversationId, sessionKey)
      : (_sessionIds.get(sessionKey) || "");
  }
  try {
    return await _rpcCallOnce(url, headers, method, params, timeoutMs, initialSessionId, sessionKey);
  } catch (error) {
    if (!initialSessionId || error?.status !== 404 || options.skipSessionRefresh) {
      throw error;
    }

    _sessionIds.delete(sessionKey);
    if (conversationId) {
      // The session expired or the server restarted: start a fresh one, and tell the model
      // so a missing terminal or job is not a mystery.
      await _initializeConversation(url, headers, conversationId, sessionKey);
      _sessionNotices.set(sessionKey, SESSION_RENEWED_NOTICE);
    } else {
      await initializeMcp(url, headers, { skipSessionRefresh: true });
    }
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

function _isOAuthChallenge(wwwAuthenticate) {
  const challenge = String(wwwAuthenticate || "");
  return /\bbearer\b/i.test(challenge) && /\bresource_metadata\s*=\s*"[^"]+"/i.test(challenge);
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
  _sessionIds.delete(_sessionKey(endpoint.url, endpoint.headers, String(options.conversationId || "").trim()));
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
export async function callMcpTool(url, headers = {}, toolName, args, timeoutMs = DEFAULT_MCP_TOOL_TIMEOUT_MS, options = {}) {
  const endpoint = _normalizeEndpoint(url, headers);
  const conversationId = String(options?.conversationId || "").trim();
  if (endpoint.type === "extension") {
    const result = await _rpcCallExtension(endpoint.extensionId, "tools/call", {
      name: toolName,
      arguments: args
    }, timeoutMs);
    if (result.content && Array.isArray(result.content)) {
      const texts = result.content
        .filter(c => c.type === "text")
        .map(c => c.text);
      if (texts.length > 0) return normalizeMcpTextResult(texts);
    }
    return result;
  }
  const result = await rpcCall(endpoint.url, endpoint.headers, "tools/call", {
    name: toolName,
    arguments: args
  }, timeoutMs, { conversationId });
  const sessionKey = _sessionKey(endpoint.url, endpoint.headers, conversationId);
  const notice = _sessionNotices.get(sessionKey);
  _sessionNotices.delete(sessionKey);
  const withNotice = value => (notice && value && typeof value === "object" ? { ...value, mcp_session_notice: notice } : value);

  // MCP returns { content: [{ type: "text", text: "..." }] }
  // Flatten to a simple string or object for LLM consumption
  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter(c => c.type === "text")
      .map(c => c.text);
    // A tool-level failure (isError) is surfaced like every other tool failure.
    if (result.isError === true && texts.length > 0) return withNotice({ error: texts.join("\n") });
    if (texts.length > 0) return withNotice(normalizeMcpTextResult(texts));
  }
  return withNotice(result);
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
      description: info.serverInfo?.description || "",
      tools,
      error: null
    };
  } catch (e) {
    if (endpoint.type === "http" && e?.status === 401 && _isOAuthChallenge(e.wwwAuthenticate)) {
      try {
        let token;
        if (endpoint.headers?.Authorization) {
          try { token = await _requestOAuthFromServiceWorker(endpoint.url, e.wwwAuthenticate, "refresh"); } catch (_) { /* fall through to full authorization */ }
        }
        if (!token) token = await _requestOAuthFromServiceWorker(endpoint.url, e.wwwAuthenticate, "authorize");
        const authorizedHeaders = buildOAuthHeaders(endpoint.headers, token);
        const info = await initializeMcp(endpoint.url, authorizedHeaders);
        const tools = await listMcpTools(endpoint.url, authorizedHeaders);
        return { name: info.serverInfo?.name || "MCP Server", description: info.serverInfo?.description || "", tools, error: null, headers: authorizedHeaders };
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
