const MAX_SUMMARY_CHARS = 240;
const MAX_TOOL_DESCRIPTION_CHARS = 160;

function trimText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function groupMcpToolsByServer(mcpTools = []) {
  const servers = new Map();
  for (const tool of Array.isArray(mcpTools) ? mcpTools : []) {
    const serverName = String(tool?._serverName || "").trim();
    const toolName = String(tool?.name || "").trim();
    if (!serverName || !toolName) continue;
    let server = servers.get(serverName);
    if (!server) {
      server = {
        name: serverName,
        lazy: tool?._lazyLoad === true,
        configuredSummary: String(tool?._lazyDescription || "").trim(),
        tools: []
      };
      servers.set(serverName, server);
    }
    server.lazy = server.lazy || tool?._lazyLoad === true;
    if (!server.configuredSummary && tool?._lazyDescription) {
      server.configuredSummary = String(tool._lazyDescription).trim();
    }
    server.tools.push(tool);
  }
  return [...servers.values()].map(server => ({
    ...server,
    summary: buildMcpServerSummary(server)
  }));
}

export function buildMcpServerSummary(server) {
  if (server?.configuredSummary) return trimText(server.configuredSummary, MAX_SUMMARY_CHARS);
  const descriptions = [...new Set((server?.tools || [])
    .map(tool => trimText(tool?.description, MAX_TOOL_DESCRIPTION_CHARS))
    .filter(Boolean))];
  if (descriptions.length > 0) {
    return trimText(descriptions.slice(0, 2).join("; "), MAX_SUMMARY_CHARS);
  }
  const names = (server?.tools || []).map(tool => String(tool?.name || "").trim()).filter(Boolean);
  return names.length > 0
    ? `Tools: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", ..." : ""}`
    : "MCP capabilities";
}

export function buildMcpRuntimePrompt(mcpTools = []) {
  const servers = groupMcpToolsByServer(mcpTools);
  if (servers.length === 0) return "No MCP servers are currently connected.";
  const lines = servers.map(server => {
    const discovery = `Discover with await tools.listTools(${JSON.stringify(server.name)}).`;
    const catalog = server.tools.map(tool => {
      const description = trimText(tool.description, MAX_TOOL_DESCRIPTION_CHARS);
      return description ? `${tool.name} (${description})` : tool.name;
    }).join(", ");
    return `- ${server.name}: ${server.summary}. Available tools: ${catalog}. ${discovery}`;
  });
  return `MCP tools are available under tools.mcp.serverName.toolName(args); use bracket notation for tool names containing special characters. Connected MCP servers:\n${lines.join("\n")}`;
}

export function findMcpRuntimeTool(mcpTools, serverName, toolName) {
  const requestedServer = String(serverName || "").trim();
  const requestedTool = String(toolName || "").trim();
  return (Array.isArray(mcpTools) ? mcpTools : []).find(tool =>
    String(tool?._serverName || "").trim() === requestedServer &&
    String(tool?.name || "").trim() === requestedTool
  ) || null;
}
