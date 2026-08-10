import { describe, expect, it } from "vitest";
import { buildMcpRuntimePrompt, groupMcpToolsByServer } from "./mcpRuntime";

describe("MCP code runtime catalog", () => {
  it("uses configured summaries and includes concise tool details in the exec prompt", () => {
    const prompt = buildMcpRuntimePrompt([{
      name: "search",
      description: "Search every issue",
      _serverName: "github",
      _lazyLoad: true,
      _lazyDescription: "GitHub issue operations"
    }]);

    expect(prompt).toContain("github: GitHub issue operations");
    expect(prompt).toContain('tools.listTools("github")');
    expect(prompt).toContain("search (Search every issue)");
  });

  it("lists eager tool names and derives a summary when none is configured", () => {
    const tools = [{
      name: "lookup",
      description: "Lookup API documentation",
      _serverName: "docs"
    }, {
      name: "fetch",
      description: "Fetch one documentation page",
      _serverName: "docs"
    }];
    const [server] = groupMcpToolsByServer(tools);
    const prompt = buildMcpRuntimePrompt(tools);

    expect(server.summary).toBe("Lookup API documentation; Fetch one documentation page");
    expect(prompt).toContain("lookup (Lookup API documentation)");
    expect(prompt).toContain("fetch (Fetch one documentation page)");
  });

  it("falls back to tool names when an MCP provides no descriptions", () => {
    const [server] = groupMcpToolsByServer([
      { name: "remember", _serverName: "memory" },
      { name: "recall", _serverName: "memory" }
    ]);

    expect(server.summary).toBe("Tools: remember, recall");
  });
});
