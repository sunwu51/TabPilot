import { describe, expect, it } from "vitest";
import { API_TYPES } from "../core/config";
import { BUILTIN_TOOL_NAMES, buildMcpToolCallName, findMcpToolByCallName, getMcpToolCallAliases, getTools, isMcpToolCallName } from "./definitions";

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

  it("matches MCP tools by the canonical call-name format and sanitized variants", () => {
    const tool = {
      name: "tavily_tavily-search",
      _serverName: "mcpcenter",
      _toolCallName: "mcp_mcpcenter_tavily_tavily-search"
    };

    expect(getMcpToolCallAliases(tool)).toEqual([
      "mcp_mcpcenter_tavily_tavily-search",
      "mcp_mcpcenter_tavily_tavily_search"
    ]);
    expect(findMcpToolByCallName([tool], "mcp_mcpcenter_tavily_tavily-search")).toBe(tool);
    expect(findMcpToolByCallName([tool], "mcp_mcpcenter_tavily_tavily_search")).toBe(tool);
    expect(findMcpToolByCallName([tool], "mcp__mcpcenter__tavily_tavily-search")).toBe(null);
    expect(findMcpToolByCallName([tool], "mcp__mcpcenter__tavily_tavily_search")).toBe(null);
    expect(isMcpToolCallName("mcp_mcpcenter_tavily_tavily_search")).toBe(true);
    expect(isMcpToolCallName("mcp__mcpcenter__tavily_tavily_search")).toBe(false);
  });

  it("keeps macro tools enabled by default", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES);

    expect(names).toContain("list_macros");
    expect(names).toContain("describe_macro");
    expect(names).toContain("run_macro");
  });

  it("keeps macro tools when beta features are disabled", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, { enableBetaFeatures: false });

    expect(names).toContain("list_macros");
    expect(names).toContain("describe_macro");
    expect(names).toContain("run_macro");
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

  it("exposes image tools only when Image API is configured", () => {
    expect(namesFor(API_TYPES.OPENAI_RESPONSES)).not.toContain("image_gen");
    expect(namesFor(API_TYPES.OPENAI_RESPONSES)).not.toContain("image_edit");

    const names = namesFor(API_TYPES.OPENAI_RESPONSES, { imageToolsEnabled: true });
    expect(names).toContain("image_gen");
    expect(names).toContain("image_edit");
    expect(BUILTIN_TOOL_NAMES).toContain("image_gen");
    expect(BUILTIN_TOOL_NAMES).toContain("image_edit");
  });

  it("hides Postdog tools by default", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES);

    expect(names).not.toContain("postdog_list_requests");
    expect(names).not.toContain("postdog_run_request");
    expect(names).not.toContain("postdog_list_history");
    expect(names).not.toContain("postdog_get_history_run");
    expect(BUILTIN_TOOL_NAMES).toContain("postdog_save_environment");
  });

  it("exposes Postdog tools for saved API request workflows when enabled", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, { postdogToolsEnabled: true });

    expect(names).toContain("postdog_list_requests");
    expect(names).toContain("postdog_run_request");
    expect(names).toContain("postdog_list_history");
    expect(names).toContain("postdog_get_history_run");
    expect(names).not.toContain("postdog_import");
    expect(names).not.toContain("postdog_export");
  });

  it("describes eval_js as usable for fetch/xhr proxy debugging", () => {
    const evalJs = getTools(API_TYPES.OPENAI_RESPONSES)
      .find(tool => tool.name === "eval_js");

    expect(evalJs.description).toContain("fetch");
    expect(evalJs.description).toContain("XMLHttpRequest");
    expect(evalJs.description).toContain("network requests and responses");
  });

  it("describes image_model_id as a configured image profile selector", () => {
    const imageGen = getTools(API_TYPES.OPENAI_RESPONSES, [], { imageToolsEnabled: true })
      .find(tool => tool.name === "image_gen");
    const imageEdit = getTools(API_TYPES.OPENAI_RESPONSES, [], { imageToolsEnabled: true })
      .find(tool => tool.name === "image_edit");

    expect(imageGen.parameters.properties.image_model_id.description).toContain("configured Image model profile id");
    expect(imageGen.parameters.properties.image_model_id.description).toContain("img_a3f09c");
    expect(imageEdit.parameters.properties.image_model_id.description).toContain("configured Image model profile id");
  });
});
