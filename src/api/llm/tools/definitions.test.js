import { describe, expect, it } from "vitest";
import { API_TYPES } from "../core/config";
import { BUILTIN_TOOL_NAMES, buildMcpToolCallName, findMcpToolByCallName, getBuiltinToolGroup, getCodeRuntimeToolDefinitions, getMcpToolCallAliases, getTools, isMcpToolCallName, listToolGroup, normalizeActiveToolNames } from "./definitions";

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

  it("groups playground, VFS, and stash tools under storage", () => {
    expect(getBuiltinToolGroup("html_playground")).toBe("storage");
    expect(getBuiltinToolGroup("vfs_read_file")).toBe("storage");
    expect(getBuiltinToolGroup("vfs_write_file")).toBe("storage");
    expect(getBuiltinToolGroup("vfs_edit_file")).toBe("storage");
    expect(getBuiltinToolGroup("stash_in_browser")).toBe("storage");
    expect(getBuiltinToolGroup("webide_project")).toBe("storage");
    expect(getBuiltinToolGroup("list_macros")).toBe("automation");
  });

  it("exposes React and Vanilla WebIDE project creation", () => {
    const tool = getTools(API_TYPES.OPENAI_RESPONSES).find(item => item.name === "webide_project");
    expect(tool.parameters.properties.template.enum).toEqual(["vanilla", "react"]);
    expect(tool.description).toContain("transformed through esm.sh");
    expect(tool.description).toContain("no npm install or package scripts run");
    expect(tool.description).toContain("Remote package CSS imports");
    expect(tool.description).toContain("peer-dependent component libraries");
    expect(tool.description).toContain("import { Button } from \"antd\"");
    expect(BUILTIN_TOOL_NAMES).toContain("webide_project");
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

  it("exposes MCP servers through exec instead of direct provider tools in code mode", () => {
    const tools = getTools(API_TYPES.OPENAI_RESPONSES, [{
      name: "lookup",
      description: "Lookup product documentation",
      _serverName: "docs",
      _lazyLoad: true,
      _lazyDescription: "Product documentation search"
    }], {
      useToolSelection: true,
      useCodeMode: true
    });
    const names = tools.map(tool => tool.name);

    expect(names).toEqual(["exec", "wait", "plan_create_for_session", "plan_update_for_session", "request_user_input", "create_subagent"]);
    const execDescription = tools.find(tool => tool.name === "exec")?.description;
    expect(execDescription).toContain("while (true)");
    expect(execDescription).toContain("for (;;)");
    expect(execDescription).toContain("Tab = { id: number");
    expect(execDescription).toContain("iterate `result.tabs`, not `result`");
    expect(execDescription).toContain("it has `tabId`, not `id`, and no nested `tab`");
    expect(execDescription).toContain("page text is in `content`");
    expect(execDescription).toContain("if (state.error) return state");
    expect(execDescription).toContain("tools.mcp.server_name.tool_name(args)");
    expect(execDescription).toContain("`html_playground` from the `storage` domain");
    expect(execDescription).toContain("tools.describeTool('storage', 'html_playground')");
    expect(execDescription).toContain("Always pass readable multi-line HTML, CSS, and JavaScript");
    expect(execDescription).toContain("never minify or collapse playground source into one line");
    expect(execDescription).toContain("docs: Product documentation search");
    expect(execDescription).toContain("lookup (Lookup product documentation)");
    const runtimeNames = getCodeRuntimeToolDefinitions().map(tool => tool.name);
    expect(runtimeNames).not.toContain("plan_create_for_session");
    expect(runtimeNames).not.toContain("plan_update_for_session");
    expect(runtimeNames).not.toContain("request_user_input");
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

  it("exposes playground creation with generic VFS read and write tools", () => {
    const tools = getTools(API_TYPES.OPENAI_RESPONSES);
    const playground = tools.find(tool => tool.name === "html_playground");
    const read = tools.find(tool => tool.name === "vfs_read_file");
    const write = tools.find(tool => tool.name === "vfs_write_file");
    const edit = tools.find(tool => tool.name === "vfs_edit_file");

    expect(playground.parameters.required).toEqual([]);
    expect(Object.keys(playground.parameters.properties)).toEqual(["playgroundId", "html", "css", "js", "expireAt", "expanded"]);
    expect(playground.description).toContain("stable playgroundId");
    expect(playground.parameters.expanded).toBeUndefined();
    expect(read.parameters.required).toEqual(["path"]);
    expect(read.parameters.properties.path.type).toBe("string");
    expect(write.parameters.required).toEqual(["path", "content"]);
    expect(write.description).toContain("expectedRevision 0");
    expect(write.parameters.properties.expireAt.type).toBe("number");
    expect(write.parameters.properties.startLine).toBeUndefined();
    expect(edit.parameters.required).toEqual([
      "path",
      "startLine",
      "endLine",
      "originalContent",
      "newContent",
      "expectedRevision"
    ]);
    expect(edit.parameters.properties.edits).toBeUndefined();
    expect(edit.description).toContain("may contain multiple lines");
    expect(playground.description).toContain("Pass any returned files path unchanged");
    expect(playground.description).toContain("expire after 24 hours");
    expect(playground.description).toContain("readable multi-line source");
    expect(write.description).toContain("never minify it into one line");
    expect(edit.description).toContain("readable, multi-line");
    expect(BUILTIN_TOOL_NAMES).toEqual(expect.arrayContaining([
      "html_playground",
      "vfs_read_file",
      "vfs_write_file",
      "vfs_edit_file"
    ]));
    expect(BUILTIN_TOOL_NAMES).not.toEqual(expect.arrayContaining(["html_playground_read", "html_playground_edit"]));
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

  it("describes eval_js as a CSP-resistant main-world Sval runtime", () => {
    const evalJs = getTools(API_TYPES.OPENAI_RESPONSES)
      .find(tool => tool.name === "eval_js");

    expect(evalJs.description).toContain("Sval");
    expect(evalJs.description).toContain("sandBox:false");
    expect(evalJs.description).toContain("main JavaScript world");
    expect(evalJs.description).toContain("chrome.scripting");
    expect(evalJs.description).toContain("XMLHttpRequest");
    expect(evalJs.description).toContain("network requests and responses");
    expect(evalJs.parameters.properties.tabId).toBeDefined();
  });

  it("exposes snapshot selectors through the existing selector parameter", () => {
    const tools = getTools(API_TYPES.OPENAI_RESPONSES);
    const snapshot = tools.find(tool => tool.name === "tab_snapshot");
    const click = tools.find(tool => tool.name === "dom_click");

    expect(snapshot.parameters.properties).toHaveProperty("tabId");
    expect(snapshot.parameters.properties).toHaveProperty("maxTextLength");
    expect(snapshot.parameters.properties).toHaveProperty("maxSnapshotChars");
    expect(snapshot.description).toContain("@snapshotId#ref");
    expect(click.parameters.properties).toHaveProperty("selector");
    expect(click.parameters.properties.selector.description).toContain("@snapshotId#ref");
    expect(click.parameters.properties).not.toHaveProperty("snapshotId");
    expect(click.parameters.properties).not.toHaveProperty("ref");
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

  it("keeps tab and page tools in the default core set when tool selection is active", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, {
      useToolSelection: true
    });

    expect(names).toContain("tool_list_group");
    expect(names).toContain("tool_enable");
    expect(names).toContain("tab_extract");
    expect(names).toContain("tab_snapshot");
    expect(names).toContain("dom_query");
    expect(names).toContain("dom_hover");
    expect(names).toContain("dom_focus");
    expect(names).toContain("dom_select_option");
    expect(names).not.toContain("download_search");
  });

  it("keeps configured image tools in the default core set", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, {
      useToolSelection: true,
      imageToolsEnabled: true
    });

    expect(names).toContain("image_gen");
    expect(names).toContain("image_edit");
  });

  it("describes each available built-in and lazy MCP group in tool_list_group", () => {
    const tool = getTools(API_TYPES.OPENAI_RESPONSES, [{
      name: "search_issues",
      _serverName: "github",
      _lazyLoad: true,
      _lazyDescription: "GitHub repositories, issues, and pull requests"
    }], { useToolSelection: true }).find(item => item.name === "tool_list_group");

    expect(tool.description).toContain("downloads: Download management");
    expect(tool.description).toContain("github: GitHub repositories, issues, and pull requests");
    expect(tool.parameters.properties.group.description).toContain("automation: Browser macros and recorded automation");
    expect(tool.parameters.properties.group.description).toContain("storage: Browser VFS files, stashes, and temporary HTML playgrounds");
    expect(tool.parameters.properties.group.enum).toBeUndefined();
  });

  it("lists lazy MCP tools by server group and silently drops unavailable active names", () => {
    const mcpTools = [{
      name: "search_issues",
      description: "Search repository issues",
      _serverName: "github",
      _toolCallName: "mcp_github_search_issues",
      _lazyLoad: true
    }];

    expect(listToolGroup("github", mcpTools)).toEqual([{
      name: "mcp_github_search_issues",
      summary: "Search repository issues"
    }]);
    expect(normalizeActiveToolNames(["tab_extract", "mcp_github_search_issues", "removed_tool"], mcpTools)).toEqual([
      "tab_extract",
      "mcp_github_search_issues"
    ]);
    expect(getTools(API_TYPES.OPENAI_RESPONSES, mcpTools, {
      useToolSelection: true,
      activeToolNames: ["mcp_github_search_issues"]
    }).map(tool => tool.name)).toContain("mcp_github_search_issues");
  });

  it("exposes create_subagent as an always-available core tool", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("create_subagent");
    expect(namesFor(API_TYPES.OPENAI_RESPONSES, { useToolSelection: true })).toContain("create_subagent");
    const tool = getTools(API_TYPES.OPENAI_RESPONSES).find(item => item.name === "create_subagent");
    expect(tool.parameters.required).toEqual(["name", "task"]);
    expect(tool.description).toContain("single-layer");
  });

  it("excludes requested tool names from the built-in list", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, { excludeToolNames: ["create_subagent", "tab_open"] });

    expect(names).not.toContain("create_subagent");
    expect(names).not.toContain("tab_open");
    expect(names).toContain("tab_list");
  });

  it("keeps create_subagent out of the code runtime tool surface", () => {
    expect(getCodeRuntimeToolDefinitions().map(tool => tool.name)).not.toContain("create_subagent");
  });

  it("limits the sub-agent to exec/wait in code mode when host-context tools are excluded", () => {
    const names = namesFor(API_TYPES.OPENAI_RESPONSES, {
      useCodeMode: true,
      excludeToolNames: ["create_subagent", "plan_create_for_session", "plan_update_for_session", "request_user_input"]
    });

    expect(names).toEqual(["exec", "wait"]);
  });
});
