import Sval from "sval";
import { BUILTIN_TOOL_GROUPS, getBuiltinToolGroup, getCodeRuntimeToolDefinitions } from "./definitions";
import { getBuiltinToolOutputSchema } from "./outputExamples";
import { findMcpRuntimeTool, groupMcpToolsByServer } from "./mcpRuntime";

const MAX_CODE_CHARS = 20000;
const MAX_LOG_ENTRIES = 100;
const MAX_RUNTIME_CALL_SUMMARY_CHARS = 200;
const JS_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function truncateRuntimeSummary(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_RUNTIME_CALL_SUMMARY_CHARS) return normalized;
  return normalized.slice(0, MAX_RUNTIME_CALL_SUMMARY_CHARS - 1).trimEnd() + "…";
}

function summarizeRuntimeCallResult(result) {
  if (result && typeof result === "object" && typeof result.error === "string" && result.error) {
    return "error: " + truncateRuntimeSummary(result.error);
  }
  if (result == null) return "";
  if (typeof result !== "object") return truncateRuntimeSummary(result);
  try {
    return truncateRuntimeSummary(JSON.stringify(result));
  } catch (_e) {
    return truncateRuntimeSummary(String(result));
  }
}

const RUNTIME_GROUP_DESCRIPTIONS = {
  tabs: "Inspect and manage browser tabs",
  page: "Inspect and interact with page content",
  ...BUILTIN_TOOL_GROUPS
};

function toSerializable(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || "" };
  if (depth >= 8) return "[Max depth]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const serialized = Array.isArray(value)
      ? value.map(item => toSerializable(item, seen, depth + 1))
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toSerializable(child, seen, depth + 1)]));
    seen.delete(value);
    return serialized;
  }
  return String(value);
}

function compactSchema(schema = {}) {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  return Object.fromEntries(Object.entries(properties).map(([name, definition]) => [name, {
    type: definition?.type || "unknown",
    required: required.has(name),
    description: definition?.description || ""
  }]));
}

function formatPropertyAccess(base, property) {
  const name = String(property || "");
  return JS_IDENTIFIER_PATTERN.test(name) ? `${base}.${name}` : `${base}[${JSON.stringify(name)}]`;
}

function formatMcpCall(serverName, toolName) {
  return `${formatPropertyAccess(formatPropertyAccess("tools.mcp", serverName), toolName)}(args)`;
}

export async function executeCodeRuntime({ code } = {}, {
  invokeTool,
  transformToolResult,
  onToolCall,
  mcpTools = [],
  supportsImageInput = false,
  imageToolsEnabled = false,
  postdogToolsEnabled = false,
  pageAgentToolsEnabled = true
} = {}) {
  const source = String(code || "");
  if (!source.trim()) return { status: "failed", error: { code: "INVALID_CODE", message: "code is required" }, logs: [] };
  if (source.length > MAX_CODE_CHARS) {
    return { status: "failed", error: { code: "CODE_TOO_LARGE", message: `code must not exceed ${MAX_CODE_CHARS} characters` }, logs: [] };
  }
  if (typeof invokeTool !== "function") {
    return { status: "failed", error: { code: "RUNTIME_UNAVAILABLE", message: "Built-in tool runtime is unavailable" }, logs: [] };
  }

  const definitions = getCodeRuntimeToolDefinitions({ supportsImageInput, imageToolsEnabled, postdogToolsEnabled, pageAgentToolsEnabled });
  const definitionsByName = new Map(definitions.map(tool => [tool.name, tool]));
  const mcpServers = groupMcpToolsByServer(mcpTools);
  const logs = [];
  let toolCallCount = 0;
  const images = [];
  const imageKeys = new Set();
  const startedAt = Date.now();

  const appendImages = items => {
    for (const image of Array.isArray(items) ? items : []) {
      if (!image || typeof image !== "object") continue;
      const key = String(image.ref || image.dataUrl || image.url || "");
      if (!key || imageKeys.has(key)) continue;
      imageKeys.add(key);
      images.push(image);
    }
  };

  const emitToolCall = event => {
    if (typeof onToolCall !== "function") return;
    try {
      onToolCall(toSerializable(event));
    } catch (_error) {
      // Display hooks must never affect code execution.
    }
  };

  const callRuntimeTool = async (name, args = {}, displayName = name) => {
    const callStartedAt = Date.now();
    const callArgs = args == null ? {} : args;
    const callIndex = toolCallCount;
    toolCallCount += 1;
    const callRecord = {
      name: displayName,
      ...(displayName !== name ? { callName: name } : {}),
      args: toSerializable(callArgs),
      status: "running"
    };
    emitToolCall({ type: "start", index: callIndex, ...callRecord });
    try {
      const rawResult = await invokeTool(name, callArgs);
      const transformed = typeof transformToolResult === "function"
        ? await transformToolResult({ name, args: callArgs, result: rawResult })
        : null;
      const result = transformed && Object.prototype.hasOwnProperty.call(transformed, "value")
        ? transformed.value
        : rawResult;
      appendImages(transformed?.images);
      Object.assign(callRecord, {
        status: result?.error ? "failed" : "completed",
        durationMs: Date.now() - callStartedAt,
        resultSummary: summarizeRuntimeCallResult(result)
      });
      emitToolCall({ type: "finish", index: callIndex, ...callRecord });
      return result;
    } catch (error) {
      Object.assign(callRecord, {
        status: "failed",
        durationMs: Date.now() - callStartedAt,
        error: error?.message || String(error),
        resultSummary: "error: " + truncateRuntimeSummary(error?.message || String(error))
      });
      emitToolCall({ type: "finish", index: callIndex, ...callRecord });
      throw error;
    }
  };

  const callBuiltin = async (name, args = {}) => {
    if (!definitionsByName.has(name)) {
      throw new Error(`Unknown or unavailable built-in tool: ${name}`);
    }
    return callRuntimeTool(name, args);
  };

  const callMcp = async (serverName, toolName, args = {}) => {
    const tool = findMcpRuntimeTool(mcpTools, serverName, toolName);
    if (!tool) {
      throw new Error(`Unknown MCP tool: ${String(serverName || "")}/${String(toolName || "")}`);
    }
    const callName = tool._toolCallName || `mcp_${tool._serverName}_${tool.name}`;
    return callRuntimeTool(callName, args, `mcp.${tool._serverName}.${tool.name}`);
  };

  const callRuntimeHelper = async (name, args, operation) => {
    const callStartedAt = Date.now();
    const callIndex = toolCallCount;
    toolCallCount += 1;
    const callRecord = { name, args: toSerializable(args), status: "running" };
    emitToolCall({ type: "start", index: callIndex, ...callRecord });
    try {
      const result = await operation();
      Object.assign(callRecord, {
        status: "completed",
        durationMs: Date.now() - callStartedAt,
        resultSummary: summarizeRuntimeCallResult(result)
      });
      emitToolCall({ type: "finish", index: callIndex, ...callRecord });
      return result;
    } catch (error) {
      Object.assign(callRecord, {
        status: "failed",
        durationMs: Date.now() - callStartedAt,
        error: error?.message || String(error),
        resultSummary: "error: " + truncateRuntimeSummary(error?.message || String(error))
      });
      emitToolCall({ type: "finish", index: callIndex, ...callRecord });
      throw error;
    }
  };

  const normalizeDomainSelector = value => typeof value === "object" && value !== null
    ? {
        source: String(value.source || "").trim(),
        domain: String(value.domain || "").trim()
      }
    : { source: "", domain: String(value || "").trim() };

  const listRuntimeDomains = () => [
    ...[...new Set(definitions.map(tool => getBuiltinToolGroup(tool.name)))].map(domain => ({
      source: "builtin",
      domain,
      summary: RUNTIME_GROUP_DESCRIPTIONS[domain] || "Built-in browser capabilities",
      toolCount: definitions.filter(tool => getBuiltinToolGroup(tool.name) === domain).length
    })),
    ...mcpServers.map(server => ({
      source: "mcp",
      domain: server.name,
      summary: server.summary,
      toolCount: server.tools.length
    }))
  ];

  const listRuntimeTools = selector => {
    const { source, domain } = normalizeDomainSelector(selector);
    const builtinTools = source && source !== "builtin" ? [] : definitions
      .filter(tool => getBuiltinToolGroup(tool.name) === domain)
      .map(tool => ({
        source: "builtin",
        domain,
        name: tool.name,
        summary: tool.description,
        input: compactSchema(tool.schema),
        outputSchema: getBuiltinToolOutputSchema(tool.name),
        call: `tools.${tool.name}(args)`
      }));
    const mcpServer = source && source !== "mcp"
      ? null
      : mcpServers.find(server => server.name === domain);
    const externalTools = (mcpServer?.tools || []).map(tool => ({
      source: "mcp",
      domain,
      name: tool.name,
      summary: tool.description || "",
      input: compactSchema(tool.inputSchema),
      outputSchema: tool.outputSchema || null,
      call: formatMcpCall(domain, tool.name)
    }));
    return [...builtinTools, ...externalTools];
  };

  const describeRuntimeTool = (selector, requestedName) => {
    if (requestedName === undefined && typeof selector === "string") {
      const builtin = definitionsByName.get(selector.trim());
      if (builtin) {
        return {
          source: "builtin",
          domain: getBuiltinToolGroup(builtin.name),
          name: builtin.name,
          description: builtin.description,
          inputSchema: builtin.schema,
          outputSchema: getBuiltinToolOutputSchema(builtin.name),
          call: `tools.${builtin.name}(args)`
        };
      }
    }
    const objectSelector = typeof selector === "object" && selector !== null ? selector : null;
    const domainSelector = normalizeDomainSelector(selector);
    const toolName = String(objectSelector?.name ?? requestedName ?? "").trim();
    const match = listRuntimeTools(domainSelector).find(tool => tool.name === toolName);
    if (!match) return null;
    if (match.source === "builtin") {
      const tool = definitionsByName.get(match.name);
      return { ...match, description: tool.description, inputSchema: tool.schema };
    }
    const tool = findMcpRuntimeTool(mcpTools, match.domain, match.name);
    return { ...match, description: tool.description || "", inputSchema: tool.inputSchema || { type: "object", properties: {} } };
  };

  const runtimeTools = {
    call: callBuiltin,
    listDomains: () => callRuntimeHelper("tools.listDomains", {}, async () => listRuntimeDomains()),
    listTools: selector => callRuntimeHelper("tools.listTools", { domain: selector }, async () => listRuntimeTools(selector)),
    describeTool: (selector, name) => callRuntimeHelper("tools.describeTool", { domain: selector, name }, async () => describeRuntimeTool(selector, name)),
    listMcpServers: () => callRuntimeHelper("tools.listMcpServers", {}, async () => (
      mcpServers.map(server => ({
        name: server.name,
        summary: server.summary,
        lazy: server.lazy,
        toolCount: server.tools.length
      }))
    )),
    listMcpTools: serverName => callRuntimeHelper("tools.listMcpTools", { serverName }, async () => {
      const server = mcpServers.find(item => item.name === String(serverName || "").trim());
      if (!server) return [];
      return server.tools.map(tool => ({
        name: tool.name,
        summary: tool.description || "",
        input: compactSchema(tool.inputSchema),
        outputSchema: tool.outputSchema || null,
        call: formatMcpCall(server.name, tool.name)
      }));
    }),
    describeMcpTool: (serverName, toolName) => callRuntimeHelper(
      "tools.describeMcpTool",
      { serverName, toolName },
      async () => {
        const tool = findMcpRuntimeTool(mcpTools, serverName, toolName);
        return tool ? {
          server: tool._serverName,
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema || { type: "object", properties: {} },
          outputSchema: tool.outputSchema || null,
          call: formatMcpCall(tool._serverName, tool.name)
        } : null;
      }
    ),
    callMcp
  };

  runtimeTools.mcp = Object.fromEntries(mcpServers.map(server => [
    server.name,
    Object.fromEntries(server.tools.map(tool => [
      tool.name,
      (args = {}) => callMcp(server.name, tool.name, args)
    ]))
  ]));

  for (const definition of definitions) {
    runtimeTools[definition.name] = (args = {}) => callBuiltin(definition.name, args);
  }

  const captureLog = level => (...args) => {
    if (logs.length >= MAX_LOG_ENTRIES) return;
    logs.push({ level, args: args.map(arg => toSerializable(arg)) });
  };
  const runtimeConsole = {
    log: captureLog("log"),
    info: captureLog("info"),
    warn: captureLog("warn"),
    error: captureLog("error")
  };
  const sleep = milliseconds => {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0 || value > 300000) {
      return Promise.reject(new Error("sleep milliseconds must be between 0 and 300000"));
    }
    return new Promise(resolve => setTimeout(resolve, Math.floor(value)));
  };

  try {
    const interpreter = new Sval({ ecmaVer: "latest", sourceType: "script", sandBox: true });
    interpreter.import({ tools: runtimeTools, sleep, console: runtimeConsole });
    interpreter.run(`exports.__result = (async () => {\n${source}\n})()`);
    const value = await interpreter.exports.__result;
    return {
      status: "completed",
      value: toSerializable(value),
      logs,
      ...(images.length > 0 ? { images: toSerializable(images) } : {}),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      status: "failed",
      error: toSerializable(error),
      logs,
      ...(images.length > 0 ? { images: toSerializable(images) } : {}),
      durationMs: Date.now() - startedAt
    };
  }
}
