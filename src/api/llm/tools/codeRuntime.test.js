import { describe, expect, it, vi } from "vitest";
import { executeCodeRuntime } from "./codeRuntime";
import { getTools, getCodeRuntimeToolDefinitions } from "./definitions";
import { API_TYPES } from "../core/config";
import { getBuiltinToolOutputSchema } from "./outputExamples";

describe("code runtime", () => {
  it("defines one successful output example for every available runtime tool", () => {
    const definitions = getCodeRuntimeToolDefinitions({
      supportsImageInput: true,
      imageToolsEnabled: true,
      postdogToolsEnabled: true
    });

    expect(definitions.filter(tool => !getBuiltinToolOutputSchema(tool.name))).toEqual([]);
  });

  it("does not expose Page Agent to exec discovery", async () => {
    const enabled = await executeCodeRuntime({ code: "return await tools.listTools('page');" }, { invokeTool: vi.fn() });
    const disabled = await executeCodeRuntime({ code: "return await tools.listTools('page');" }, {
      invokeTool: vi.fn(),
      pageAgentToolsEnabled: false
    });

    expect(enabled.value.map(tool => tool.name)).not.toContain("page_agent_execute");
    expect(disabled.value.map(tool => tool.name)).not.toContain("page_agent_execute");
  });

  it("documents core tool schemas and discovery request and result examples for exec", () => {
    const [exec] = getTools(API_TYPES.OPENAI_CHAT_COMPLETIONS, [], {
      supportsImageInput: true,
      imageToolsEnabled: true,
      postdogToolsEnabled: true,
      useCodeMode: true
    }).filter(tool => tool.function.name === "exec").map(tool => tool.function);

    expect(exec.description).toContain("tools.eval_js({ tabId?: number, jsScript: string })");
    expect(exec.description).toContain("do not guess argument names");
    expect(exec.description).toContain("await tools.listTools('tabs')");
    expect(exec.description).toContain("Array<{ source: 'builtin'|'mcp'");
    expect(exec.description).toContain("await tools.describeTool('tab_open')");
    expect(exec.description).toContain("inputSchema: object");
  });

  it("awaits built-in tools and returns an explicit value", async () => {
    const invokeTool = vi.fn(async (name, args) => ({ name, args, value: args.value * 2 }));

    const result = await executeCodeRuntime({
      code: "const result = await tools.get_current_time({ value: 3 }); return { value: result.value };"
    }, { invokeTool });

    expect(result).toMatchObject({
      status: "completed",
      value: { value: 6 }
    });
    expect(result).not.toHaveProperty("toolCalls");
    expect(invokeTool).toHaveBeenCalledWith("get_current_time", { value: 3 });
  });

  it("supports Promise.all and captures console output separately", async () => {
    const invokeTool = vi.fn(async (name) => ({ name }));

    const result = await executeCodeRuntime({
      code: "const values = await Promise.all([tools.tab_list({}), tools.tab_get_active({})]); console.log('count', values.length); return values;"
    }, { invokeTool });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual([{ name: "tab_list" }, { name: "tab_get_active" }]);
    expect(result.logs).toEqual([{ level: "log", args: ["count", 2] }]);
  });

  it("returns sanitized image refs to code and exports image artifacts separately", async () => {
    const rawDataUrl = "data:image/png;base64,aGVsbG8=";
    const transformToolResult = vi.fn(({ result }) => ({
      value: { ...result, dataUrl: "|deRef:img_1|" },
      images: [{ ref: "img_1", dataUrl: rawDataUrl, mediaType: "image/png" }]
    }));

    const result = await executeCodeRuntime({
      code: "const shot = await tools.tab_screenshot({ tabId: 7 }); console.log(shot); return shot;"
    }, {
      invokeTool: vi.fn(async () => ({ success: true, dataUrl: rawDataUrl })),
      transformToolResult,
      supportsImageInput: true
    });

    expect(result.value).toEqual({ success: true, dataUrl: "|deRef:img_1|" });
    expect(result.logs).toEqual([{
      level: "log",
      args: [{ success: true, dataUrl: "|deRef:img_1|" }]
    }]);
    expect(result.images).toEqual([
      { ref: "img_1", dataUrl: rawDataUrl, mediaType: "image/png" }
    ]);
    expect(JSON.stringify({ value: result.value, logs: result.logs })).not.toContain(rawDataUrl);
  });

  it("emits lifecycle hooks for nested built-in calls", async () => {
    const events = [];
    const result = await executeCodeRuntime({
      code: "return await tools.tab_list({ windowId: 3 });"
    }, {
      invokeTool: vi.fn(async () => ({ tabs: [] })),
      onToolCall: event => events.push(event)
    });

    expect(result).not.toHaveProperty("toolCalls");
    expect(events).toEqual([
      expect.objectContaining({ type: "start", index: 0, name: "tab_list", args: { windowId: 3 }, status: "running" }),
      expect.objectContaining({ type: "finish", index: 0, name: "tab_list", status: "completed" })
    ]);
  });

  it("discovers built-in domains and full input schemas without invoking a tool", async () => {
    const invokeTool = vi.fn();
    const result = await executeCodeRuntime({
      code: "const domains = await tools.listDomains(); const detail = await tools.describeTool('tab_open'); return { domains, detail };"
    }, { invokeTool });

    expect(result.value.domains).toContainEqual(expect.objectContaining({ source: "builtin", domain: "tabs" }));
    expect(result.value.detail).toMatchObject({
      name: "tab_open",
      inputSchema: { type: "object" },
      outputSchema: { example: { success: true, tabId: 101, url: "https://example.com/" } }
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("emits lifecycle hooks for unified built-in and MCP discovery helpers", async () => {
    const events = [];
    const mcpTools = [{
      name: "lookup",
      _serverName: "docs",
      _toolCallName: "mcp_docs_lookup"
    }];

    const result = await executeCodeRuntime({
      code: "await tools.listDomains(); await tools.listTools('tabs'); await tools.describeTool('tab_list'); await tools.listTools('docs'); return await tools.describeTool('docs', 'lookup');"
    }, {
      invokeTool: vi.fn(),
      mcpTools,
      onToolCall: event => events.push(event)
    });

    expect(result.status).toBe("completed");
    expect(events.filter(event => event.type === "start").map(event => event.name)).toEqual([
      "tools.listDomains",
      "tools.listTools",
      "tools.describeTool",
      "tools.listTools",
      "tools.describeTool"
    ]);
    expect(events.filter(event => event.type === "finish").every(event => event.status === "completed")).toBe(true);
  });

  it("discovers and calls MCP tools through the namespaced runtime", async () => {
    const mcpTools = [{
      name: "search-issues",
      description: "Search repository issues",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"]
      },
      outputSchema: { type: "object", properties: { total: { type: "number" } } },
      _serverName: "github",
      _toolCallName: "mcp_github_search-issues",
      _lazyLoad: true,
      _lazyDescription: "GitHub repositories and issues"
    }];
    const invokeTool = vi.fn(async () => ({ total: 2 }));
    const events = [];

    const result = await executeCodeRuntime({
      code: "const domains = await tools.listDomains(); const listed = await tools.listTools('github'); const detail = await tools.describeTool('github', 'search-issues'); const found = await tools.mcp.github['search-issues']({ query: 'bug' }); return { domains, listed, detail, found };"
    }, { invokeTool, mcpTools, onToolCall: event => events.push(event) });

    expect(result.value.domains).toContainEqual({
      source: "mcp",
      domain: "github",
      summary: "GitHub repositories and issues",
      toolCount: 1
    });
    expect(result.value.listed[0]).toMatchObject({
      source: "mcp",
      domain: "github",
      name: "search-issues",
      input: { query: { type: "string", required: true } },
      outputSchema: mcpTools[0].outputSchema,
      call: 'tools.mcp.github["search-issues"](args)'
    });
    expect(result.value.detail).toMatchObject({
      source: "mcp",
      domain: "github",
      name: "search-issues",
      inputSchema: mcpTools[0].inputSchema,
      outputSchema: mcpTools[0].outputSchema
    });
    expect(result.value.found).toEqual({ total: 2 });
    expect(invokeTool).toHaveBeenCalledWith("mcp_github_search-issues", { query: "bug" });
    expect(result).not.toHaveProperty("toolCalls");
    expect(events.filter(event => event.name === "mcp.github.search-issues")).toEqual([
      expect.objectContaining({
        type: "start",
        name: "mcp.github.search-issues",
        callName: "mcp_github_search-issues",
        status: "running"
      }),
      expect.objectContaining({
        type: "finish",
        name: "mcp.github.search-issues",
        callName: "mcp_github_search-issues",
        status: "completed"
      })
    ]);
  });

  it("disambiguates MCP servers that share a built-in domain name", async () => {
    const result = await executeCodeRuntime({
      code: "const mcp = await tools.listTools({ source: 'mcp', domain: 'tabs' }); const builtin = await tools.listTools({ source: 'builtin', domain: 'tabs' }); return { mcp, builtin };"
    }, {
      invokeTool: vi.fn(),
      mcpTools: [{ name: "search", description: "Search remote tabs", _serverName: "tabs" }]
    });

    expect(result.value.mcp).toEqual([
      expect.objectContaining({ source: "mcp", domain: "tabs", name: "search" })
    ]);
    expect(result.value.builtin.length).toBeGreaterThan(0);
    expect(result.value.builtin.every(tool => tool.source === "builtin" && tool.domain === "tabs")).toBe(true);
  });

  it("supports callMcp and rejects unknown MCP tools", async () => {
    const mcpTools = [{ name: "lookup", _serverName: "docs", _toolCallName: "mcp_docs_lookup" }];
    const called = await executeCodeRuntime({
      code: "return await tools.callMcp('docs', 'lookup', { id: 3 });"
    }, { invokeTool: vi.fn(async () => ({ ok: true })), mcpTools });
    const missing = await executeCodeRuntime({
      code: "return await tools.callMcp('docs', 'missing', {});"
    }, { invokeTool: vi.fn(), mcpTools });

    expect(called.value).toEqual({ ok: true });
    expect(missing).toMatchObject({
      status: "failed",
      error: { message: "Unknown MCP tool: docs/missing" }
    });
  });

  it("includes an output example in compact tool listings", async () => {
    const result = await executeCodeRuntime({
      code: "return await tools.listTools('tabs');"
    }, { invokeTool: vi.fn() });

    const tabList = result.value.find(tool => tool.name === "tab_list");
    expect(tabList.outputSchema.example).toMatchObject({ count: 1, tabs: [{ id: 101 }] });
  });

  it("describes image tool outputs with runtime refs instead of base64", async () => {
    const result = await executeCodeRuntime({
      code: "return await tools.describeTool('tab_screenshot');"
    }, { invokeTool: vi.fn(), supportsImageInput: true });

    expect(result.value.outputSchema.example.dataUrl).toBe("|deRef:img_1|");
  });

  it("returns structured failures for invalid code and unknown tools", async () => {
    const invalid = await executeCodeRuntime({ code: "return )" }, { invokeTool: vi.fn() });
    const unknown = await executeCodeRuntime({ code: "return await tools.call('missing', {});" }, { invokeTool: vi.fn() });

    expect(invalid).toMatchObject({ status: "failed", error: { message: expect.any(String) } });
    expect(unknown).toMatchObject({ status: "failed", error: { message: "Unknown or unavailable built-in tool: missing" } });
  });
});
