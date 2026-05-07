let _rpcId = 0;
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60000;

/**
 * Send a JSON-RPC 2.0 request to an MCP server via Streamable HTTP.
 * Handles both JSON and SSE response content types.
 * @param {string} url - MCP server endpoint
 * @param {Object} headers - custom headers (e.g. Authorization)
 * @param {string} method - JSON-RPC method (e.g. "tools/list")
 * @param {Object} [params] - method parameters
 * @returns {Promise<Object>} JSON-RPC result
 */
async function rpcCall(url, headers, method, params, timeoutMs) {
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
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...headers
      },
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
    throw new Error(`MCP error ${res.status}: ${errText}`);
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
export async function initializeMcp(url, headers = {}) {
  const result = await rpcCall(url, headers, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "TabManager",
      version: "1.0"
    }
  });
  return result;
}

/**
 * Fetch available tools from an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @returns {Promise<Array<{name: string, description: string, inputSchema: Object}>>}
 */
export async function listMcpTools(url, headers = {}) {
  const result = await rpcCall(url, headers, "tools/list");
  return result.tools || [];
}

/**
 * Fetch available resources from an MCP server.
 * @param {string} url - server endpoint
 * @param {Object} headers - custom headers
 * @returns {Promise<Array<{name: string, uri: string, description?: string, mimeType?: string}>>}
 */
export async function listMcpResources(url, headers = {}) {
  const result = await rpcCall(url, headers, "resources/list");
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
  return await rpcCall(url, headers, "resources/read", { uri });
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
  const result = await rpcCall(url, headers, "tools/call", {
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
  try {
    const info = await initializeMcp(url, headers);
    const tools = await listMcpTools(url, headers);
    return {
      name: info.serverInfo?.name || "MCP Server",
      tools,
      error: null
    };
  } catch (e) {
    return {
      name: "MCP Server",
      tools: [],
      error: e.message
    };
  }
}
