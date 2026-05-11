import { describe, expect, it } from "vitest";
import { API_TYPES } from "./config";
import { BUILTIN_TOOL_NAMES, buildMcpToolCallName, getTools } from "./tools";

function namesFor(apiType, options) {
  return getTools(apiType, [], options).map(tool => {
    if (tool.name) return tool.name;
    return tool.function.name;
  });
}

describe("llm tool definitions", () => {
  it("builds deterministic MCP tool call names", () => {
    expect(buildMcpToolCallName("local", "search")).toBe("mcp_local_search");
  });

  it("keeps beta macro tools enabled by default", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES);

    expect(names).toContain("list_macros");
    expect(names).toContain("describe_macro");
    expect(names).toContain("run_macro");
  });

  it("filters beta macro tools when beta features are disabled", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, { enableBetaFeatures: false });

    expect(names).not.toContain("list_macros");
    expect(names).not.toContain("describe_macro");
    expect(names).not.toContain("run_macro");
    expect(names).toContain("tab_open");
  });

  it("hides screenshot tool for text-only models", () => {
    expect(namesFor(API_TYPES.OPENAI_RESPONSES, { supportsImageInput: false })).not.toContain("tab_screenshot");
    expect(namesFor(API_TYPES.OPENAI_RESPONSES, { supportsImageInput: true })).toContain("tab_screenshot");
  });

  it("can return only MCP tools when built-ins are disabled", () => {
    const tools = getTools(API_TYPES.OPENAI_RESPONSES, [
      {
        name: "lookup",
        description: "Lookup docs",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        _serverName: "docs"
      }
    ], { includeBuiltins: false });

    expect(tools).toEqual([
      {
        type: "function",
        name: "mcp_docs_lookup",
        description: "[MCP] Lookup docs",
        parameters: { type: "object", properties: { query: { type: "string" } } },
        strict: false
      }
    ]);
  });

  it("formats tools for OpenAI chat completions", () => {
    const [tool] = getTools(API_TYPES.OPENAI_CHAT_COMPLETIONS, [], { includeBuiltins: false });

    expect(tool).toBeUndefined();

    const [mcpTool] = getTools(API_TYPES.OPENAI_CHAT_COMPLETIONS, [{ name: "ping" }], { includeBuiltins: false });
    expect(mcpTool.type).toBe("function");
    expect(mcpTool.function.name).toBe("mcp_server_ping");
    expect(mcpTool.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("formats tools for Anthropic", () => {
    const [tool] = getTools(API_TYPES.ANTHROPIC, [{ name: "ping" }], { includeBuiltins: false });

    expect(tool).toEqual({
      name: "mcp_server_ping",
      description: "[MCP] ping",
      input_schema: { type: "object", properties: {} }
    });
  });

  it("keeps run_macro arguments flat and without tabId", () => {
    const runMacro = getTools(API_TYPES.OPENAI_RESPONSES).find(tool => tool.name === "run_macro");

    expect(runMacro.parameters.required).toEqual(["id"]);
    expect(Object.keys(runMacro.parameters.properties)).toEqual(["id", "inputValues", "speed", "stepDelayMs"]);
    expect(runMacro.parameters.properties.speed.enum).toEqual(["slow", "normal", "fast", "instant"]);
    expect(BUILTIN_TOOL_NAMES).toContain("run_macro");
  });

  it("exposes html_playground with optional expanded parameter", () => {
    const playground = getTools(API_TYPES.OPENAI_RESPONSES).find(tool => tool.name === "html_playground");

    expect(playground.parameters.required).toEqual([]);
    expect(Object.keys(playground.parameters.properties)).toEqual(["html", "css", "js", "expanded"]);
    expect(playground.parameters.properties.html.description).toContain("<style>");
    expect(playground.parameters.properties.expanded.description).toContain("Defaults to false");
    expect(BUILTIN_TOOL_NAMES).toContain("html_playground");
  });
});
