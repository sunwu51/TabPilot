/* global chrome */
import { callMcpTool } from "./mcp";
import { resolveLlmRequestUrl } from "./llmEndpoint";

const DOM_LOCATOR_PROPERTIES = {
  tabId: { type: "number", description: "Optional browser tab ID. Defaults to the current active tab." },
  selector: { type: "string", description: "Optional CSS selector used to find elements." },
  text: { type: "string", description: "Optional text to match against element text or labels." },
  matchExact: { type: "boolean", description: "Whether text matching should be exact. Defaults to false." },
  index: { type: "number", description: "Zero-based index within the matched elements. Defaults to 0." }
};
const DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
const DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 60;
const DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS = 10;
const DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS = 20;
const MAX_LLM_STREAM_RETRIES = 3;
const SCHEDULE_STORAGE_KEY = "scheduledJobs";
const SCHEDULE_RETENTION_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_FIRE_ALARM_PREFIX = "schedule-fire:";
const SCHEDULE_CLEANUP_ALARM_PREFIX = "schedule-cleanup:";
const TERMINAL_SCHEDULE_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

// ==================== Tool Definitions ====================

export const TOOLS = [
  {
    name: "tab_list",
    description: "Get a snapshot of all currently open browser tabs. Returns each tab's id, url, title, and lastAccessed, plus capturedAt timing fields so you can judge whether the tab state may be stale and refresh it again if needed. Use when the user asks about open tabs, browser context, or page-related questions and you need to identify the right tab first.",
    schema: {
      type: "object",
      properties: {
        maxSize: {
          type: "number",
          description: "Maximum number of tabs to return. Defaults to -1 (no limit)."
        },
        briefUrl: {
          type: "boolean",
          description: "If true, return only the hostname (domain) instead of the full URL. Useful to reduce response size when full URLs are not needed."
        }
      },
      required: []
    }
  },
  {
    name: "tab_extract",
    description: "Extract the text content of a browser tab. Also returns tab metadata including title, url, and lastAccessed when available. Use when you need to read page content to answer the user's question.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "The browser tab ID to extract content from" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "tab_scroll",
    description: "Scroll a browser tab and return the updated scroll position. Use when you need to inspect another part of the currently visible page before taking another screenshot or reading the layout. If tabId is omitted, scrolls the current active tab.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional browser tab ID. Defaults to the current active tab." },
        deltaY: { type: "number", description: "Optional vertical scroll delta in pixels. Positive scrolls down, negative scrolls up." },
        pageFraction: { type: "number", description: "Optional fraction of one viewport height to scroll, such as 0.8 or -1." },
        position: {
          type: "string",
          enum: ["top", "bottom"],
          description: "Optional absolute scroll target. Use 'top' or 'bottom'."
        },
        behavior: {
          type: "string",
          enum: ["auto", "smooth"],
          description: "Scroll behavior. Defaults to 'auto'."
        }
      },
      required: []
    }
  },
  {
    name: "dom_query",
    description: "Query the current page DOM and return matching elements with text, attributes, positions, and match count. Use this to inspect the page structure before interacting with it.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        maxResults: { type: "number", description: "Maximum number of matching elements to return (default 5, max 20)." }
      },
      required: []
    }
  },
  {
    name: "dom_click",
    description: "Click a DOM element on the page by selector or text match. Use this for buttons, links, tabs, menus, and other clickable elements.",
    schema: {
      type: "object",
      properties: DOM_LOCATOR_PROPERTIES,
      required: []
    }
  },
  {
    name: "dom_set_value",
    description: "Set the value of an input, textarea, or select element and dispatch input/change events. Use this to fill forms or update controls.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        value: { type: "string", description: "The value to set on the target form element." }
      },
      required: ["value"]
    }
  },
  {
    name: "dom_style",
    description: "Temporarily apply inline CSS styles to a matched DOM element. Useful for visual debugging or emphasizing an element for the user.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        styles: {
          type: "object",
          description: "Object mapping CSS property names to values, e.g. {\"outline\":\"3px solid red\"}"
        },
        durationMs: { type: "number", description: "How long to keep the styles before restoring them (default 2000ms)." }
      },
      required: ["styles"]
    }
  },
  {
    name: "dom_get_html",
    description: "Get the inner or outer HTML of a matched DOM element. Use this when you need markup context for a specific part of the page.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        mode: {
          type: "string",
          enum: ["outer", "inner"],
          description: "Whether to return the element's outerHTML or innerHTML. Defaults to outer."
        },
        maxLength: { type: "number", description: "Maximum HTML length to return (default 4000, max 20000)." }
      },
      required: []
    }
  },
  {
    name: "dom_highlight",
    description: "Scroll the page to a matched DOM element and flash a visible highlight around it for about one second so the user can spot it on the page.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        durationMs: { type: "number", description: "How long the highlight should remain visible (default 1000ms)." }
      },
      required: []
    }
  },
  {
    name: "eval_js",
    description: "Dangerous tool. Execute arbitrary JavaScript on the current active page in the page's main JavaScript context. Use only when structured DOM tools are insufficient. The application will handle explicit user confirmation before execution, so do not ask the user for confirmation in natural language; call the tool directly when needed.",
    schema: {
      type: "object",
      properties: {
        jsScript: { type: "string", description: "JavaScript source code to execute in the page's main world. Use `return ...` if you want a result value back." }
      },
      required: ["jsScript"]
    }
  },
  {
    name: "tab_open",
    description: "Open a new browser tab with the given URL. By default focuses on the new tab. Returns tab metadata including lastAccessed when available.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to open" },
        active: { type: "boolean", description: "Whether to focus on the new tab (default true). Set false to open in background." }
      },
      required: ["url"]
    }
  },
  {
    name: "tab_focus",
    description: "Switch focus to an existing browser tab by its ID. If the tab is in a different browser window, move it into the current window first, then focus it. Returns tab metadata including windowId and lastAccessed when available.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "The tab ID to focus on" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "tab_close",
    description: "Close one or more browser tabs by their IDs. Returns metadata for each tab before it was closed, including lastAccessed when available.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to close"
        }
      },
      required: ["tabIds"]
    }
  },
  {
    name: "tab_group",
    description: "Group multiple browser tabs together with a label and color. Use when the user asks to organize tabs.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to group together"
        },
        name: { type: "string", description: "Display name for the tab group" },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
          description: "Color for the tab group"
        }
      },
      required: ["tabIds", "name"]
    }
  },
  {
    name: "group_list",
    description: "Get a snapshot of all tab groups across browser windows. Returns each group's metadata and current tabs, plus capturedAt timing fields. Use when the user asks about groups or tab organization.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "group_get",
    description: "Get a snapshot of a specific tab group by its groupId, including current tabs and capturedAt timing fields.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" }
      },
      required: ["groupId"]
    }
  },
  {
    name: "group_update",
    description: "Update a tab group's title, color, and/or collapsed state. Returns the updated group snapshot.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" },
        name: { type: "string", description: "New display title for the group" },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
          description: "New color for the tab group"
        },
        collapsed: { type: "boolean", description: "Whether the group should be collapsed" }
      },
      required: ["groupId"]
    }
  },
  {
    name: "group_add_tabs",
    description: "Add one or more tabs to an existing tab group. Returns the updated group snapshot.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" },
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to add to the group"
        }
      },
      required: ["groupId", "tabIds"]
    }
  },
  {
    name: "group_remove_tabs",
    description: "Remove one or more tabs from their current tab groups. Returns the updated tab metadata after ungrouping.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to remove from their current groups"
        }
      },
      required: ["tabIds"]
    }
  },
  {
    name: "group_ungroup",
    description: "Dissolve an entire tab group by its groupId. Returns the group snapshot captured before ungrouping and the resulting tabs.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" }
      },
      required: ["groupId"]
    }
  },
  {
    name: "history_search",
    description: "Search browser history by keyword. Returns recent matching URLs with titles and visit times. Use when the user asks about previously visited pages.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
        maxResults: { type: "number", description: "Maximum number of results to return (default 10)" }
      },
      required: ["query"]
    }
  },
  {
    name: "history_recent",
    description: "List recent browser history entries within a time range. Use when the user asks for recently visited pages without a keyword filter.",
    schema: {
      type: "object",
      properties: {
        startTime: { type: "number", description: "Optional inclusive start timestamp in milliseconds. Defaults to 7 days ago." },
        endTime: { type: "number", description: "Optional inclusive end timestamp in milliseconds. Defaults to now." },
        maxResults: { type: "number", description: "Maximum number of results to return (default 100, max 100)." }
      },
      required: []
    }
  },
  {
    name: "tab_get_active",
    description: "Get a snapshot of the active tab in the current extension/side-panel window. Use when the user says 'this page', 'current page', 'the page I'm looking at', etc. This does not require Chrome to have operating-system focus. Returns the tab's ID, URL, title, lastAccessed, and capturedAt timing fields so you can then use tab_extract to read its content and judge whether the snapshot may need refreshing.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "tab_screenshot",
    description:
      "Capture a screenshot of a browser tab. By default captures only the visible viewport using Chrome's captureVisibleTab (requires that tab to be active in its window). Set fullPage: true to capture the full scrollable page by stitching multiple viewport screenshots. In full-page mode, sticky headers (position:fixed/sticky elements near the top) are automatically hidden after the first frame to prevent content obstruction. Output is width-capped JPEG for readability.",
    schema: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "Window ID passed to captureVisibleTab (default: the resolved tab's window)" },
        tabId: { type: "number", description: "Optional tab to capture. When omitted, uses the active tab in the current extension/side-panel window. When set, that tab is activated before capture." },
        fullPage: { type: "boolean", description: "When true, capture the entire scrollable page by scrolling and stitching viewport screenshots together. Sticky headers are automatically hidden after the first frame to prevent content obstruction." },
        maxScreens: { type: "number", description: "Maximum number of viewport screenshots to capture for fullPage mode (default: 40, range: 1-100). Only used when fullPage is true." },
        settleMs: { type: "number", description: "Milliseconds to wait after scrolling for lazy content to render (default: 250, range: 0-5000). Only used when fullPage is true." }
      },
      required: []
    }
  },
  {
    name: "window_list",
    description: "Get a snapshot of all browser windows. Returns each window's metadata and its current tabs, plus capturedAt timing fields. Use when the user asks about windows, cross-window tab organization, or which window contains a tab.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "window_get_current",
    description: "Get a snapshot of the current browser window, including its tabs and capturedAt timing fields.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "window_focus",
    description: "Focus a browser window by its ID. Returns the focused window snapshot.",
    schema: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "The browser window ID to focus" }
      },
      required: ["windowId"]
    }
  },
  {
    name: "window_move_tab",
    description: "Move one or more tabs into a target browser window. Returns metadata for the moved tabs and the target window snapshot.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to move"
        },
        windowId: { type: "number", description: "The target browser window ID" }
      },
      required: ["tabIds", "windowId"]
    }
  },
  {
    name: "window_create",
    description: "Create a new browser window. You may optionally provide a URL to open and whether the new window should be focused.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL to open in the new window" },
        focused: { type: "boolean", description: "Whether the new window should be focused (default true)" }
      },
      required: []
    }
  },
  {
    name: "window_close",
    description: "Close a browser window by its ID. Returns the window snapshot captured before closing.",
    schema: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "The browser window ID to close" }
      },
      required: ["windowId"]
    }
  },
  {
    name: "get_current_time",
    description: "Get the current date, time and timezone. Use when you need to know the current time, or when the user asks about time, or before setting a reminder with an absolute timestamp.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "schedule_tool",
    description: "Schedule a tool call to execute at a future time. You MUST provide both toolName and toolArgs. toolName must be one of the available built-in tools or connected MCP tools. toolArgs must be a JSON object and must strictly match the input format required by the selected toolName. Provide EITHER delaySeconds (relative, preferred) OR timestamp (absolute). Example: schedule tab_open to open a URL in 5 minutes. Recommendation: because scheduled jobs run inside the Chrome host process, they will disappear and cannot execute after Chrome is closed, so avoid creating jobs too far in the future whenever possible.",
    schema: {
      type: "object",
      properties: {
        delaySeconds: { type: "number", description: "Seconds from now (e.g. 300 for 5 minutes). Preferred." },
        timestamp: { type: "number", description: "Absolute Unix timestamp in ms. Only if user gives exact datetime." },
        toolName: { type: "string", description: "Name of the tool to call (e.g. tab_open, tab_close, mcp__xxx)" },
        toolArgs: { type: "object", description: "Required JSON object of arguments for the selected toolName. The shape and field names must strictly match that tool's input schema." },
        label: { type: "string", description: "Short human-readable description of this scheduled task" },
        timeoutSeconds: { type: "number", description: `Maximum execution time after the schedule fires. Defaults to ${DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS} seconds.` }
      },
      required: ["toolName", "toolArgs"]
    }
  },
  {
    name: "list_scheduled",
    description: "List all scheduled jobs that are pending, running, or completed within the last 24 hours, including their IDs, labels, planned fire times, and statuses.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "cancel_scheduled",
    description: "Cancel a pending scheduled tool call by its ID. Cancelled jobs remain visible with status=cancelled for 24 hours before cleanup.",
    schema: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to cancel" }
      },
      required: ["scheduleId"]
    }
  },
  {
    name: "clear_completed_scheduled",
    description: "Manually clear completed scheduled jobs, including succeeded, failed, and cancelled entries.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "stash_in_browser",
    description: "Stash information in browser local storage with an optional expiration time. A stash is like a personal memory vault — use it to remember facts, user preferences, context, or notes that should persist across conversations. Stashes are stored per-extension and shared across all tabs. Not related to browser history or browsing records.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A unique title/key for this stash. Used to look up and manage the stash later." },
        info: { type: "string", description: "The information content to store in the stash." },
        expireAt: { type: "number", description: "Expiration timestamp in Unix milliseconds. Use -1 for permanent storage. Defaults to 1 month from now if omitted." }
      },
      required: ["title", "info"]
    }
  },
  {
    name: "unstash_in_browser",
    description: "Retrieve a previously stashed information entry by its title. Returns the stored info string, or an error if the title is not found or the stash has expired.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title/key of the stash to retrieve." }
      },
      required: ["title"]
    }
  },
  {
    name: "list_stashes_in_browser",
    description: "List all stash titles currently stored in browser local storage. Expired stashes are automatically filtered out. Use this to discover what stashes exist before retrieving them.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "remove_stash_in_browser",
    description: "Remove a stash entry by its title. Returns success whether or not the stash existed.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title/key of the stash to remove." }
      },
      required: ["title"]
    }
  },
  {
    name: "save_to_file",
    description: "Save arbitrary string content as a file and trigger a browser download. The file is created as a Blob and downloaded using an anchor element. Use this to export data, save generated text, or create downloadable artifacts for the user.",
    schema: {
      type: "object",
      properties: {
        fileName: { type: "string", description: "The name of the file to download, including extension (e.g. 'report.md', 'data.json', 'notes.txt')." },
        content: { type: "string", description: "The full string content to write into the file." }
      },
      required: ["fileName", "content"]
    }
  }
];

export const BUILTIN_TOOL_COUNT = TOOLS.length;
export const BUILTIN_TOOL_NAMES = TOOLS.map(t => t.name);

export function buildMcpToolCallName(serverName, toolName) {
  return `mcp_${serverName}_${toolName}`;
}

/**
 * Get tool definitions formatted for the specified API type.
 * Merges built-in tools with MCP tools.
 * @param {string} apiType - "openai" or "anthropic"
 * @param {Array} [mcpTools] - MCP tools from connected servers [{name, description, inputSchema, _serverUrl, _serverHeaders, _toolCallName}]
 * @param {Object} [options]
 * @param {boolean} [options.includeBuiltins=true] - Whether to include built-in browser tools
 * @param {boolean} [options.supportsImageInput=false] - Whether the selected model accepts image inputs
 * @returns {Array} formatted tool definitions
 */
export function getTools(apiType, mcpTools = [], { includeBuiltins = true, supportsImageInput = false } = {}) {
  // Convert MCP tools to our internal format
  const externalTools = mcpTools.map(t => ({
    name: t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name),
    description: `[MCP] ${t.description || t.name}`,
    schema: t.inputSchema || { type: "object", properties: {} }
  }));

  const builtInTools = includeBuiltins
    ? TOOLS.filter(tool => supportsImageInput || tool.name !== "tab_screenshot")
    : [];
  const allTools = [...builtInTools, ...externalTools];

  if (apiType === "anthropic") {
    return allTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema
    }));
  }
  return allTools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema
    }
  }));
}

// ==================== Tool Executors ====================

/**
 * Execute a tool call by name. Routes to the appropriate handler.
 * MCP tool names use the configured server name namespace and are routed
 * to the corresponding MCP server.
 * All executors return a result object (never throw).
 * @param {string} name - tool name
 * @param {Object} args - tool arguments
 * @param {Array} [mcpRegistry] - MCP tool registry [{name, _serverUrl, _serverHeaders, _toolCallName}]
 * @returns {Promise<Object>} result to send back to LLM
 */
export async function executeTool(name, args, mcpRegistry = []) {
  try {
    // Route MCP tools to external server
    if (name.startsWith("mcp_")) {
      const mcpTool = mcpRegistry.find(t =>
        (t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name)) === name
      );
      if (!mcpTool) return { error: `MCP tool not found: ${name}` };
      const { mcpToolTimeoutSeconds } = await chrome.storage.local.get({
        mcpToolTimeoutSeconds: DEFAULT_MCP_TOOL_TIMEOUT_SECONDS
      });
      const timeoutMs = Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_MCP_TOOL_TIMEOUT_SECONDS) * 1000;

      return await callMcpTool(mcpTool._serverUrl, mcpTool._serverHeaders, mcpTool.name, args, timeoutMs);
    }

    // Built-in tools
    const runBuiltinTool = () => {
      switch (name) {
        case "tab_list":    return _execTabList(args);
        case "tab_extract": return _execTabExtract(args);
        case "tab_scroll":  return _execTabScroll(args);
        case "dom_query":   return _execDomQuery(args);
        case "dom_click":   return _execDomClick(args);
        case "dom_set_value": return _execDomSetValue(args);
        case "dom_style":   return _execDomStyle(args);
        case "dom_get_html": return _execDomGetHtml(args);
        case "dom_highlight": return _execDomHighlight(args);
        case "eval_js":     return _execEvalJs(args);
        case "tab_open":    return _execTabOpen(args);
        case "tab_focus":   return _execTabFocus(args);
        case "tab_close":   return _execTabClose(args);
        case "tab_group":   return _execTabGroup(args);
        case "group_list": return _execGroupList(args);
        case "group_get": return _execGroupGet(args);
        case "group_update": return _execGroupUpdate(args);
        case "group_add_tabs": return _execGroupAddTabs(args);
        case "group_remove_tabs": return _execGroupRemoveTabs(args);
        case "group_ungroup": return _execGroupUngroup(args);
        case "history_search": return _execHistorySearch(args);
        case "history_recent": return _execHistoryRecent(args);
        case "tab_get_active": return _execTabGetActive(args);
        case "tab_screenshot": return _execTabScreenshot(args);
        case "window_list": return _execWindowList(args);
        case "window_get_current": return _execWindowGetCurrent(args);
        case "window_focus": return _execWindowFocus(args);
        case "window_move_tab": return _execWindowMoveTab(args);
        case "window_create": return _execWindowCreate(args);
        case "window_close": return _execWindowClose(args);
        case "get_current_time": return _execGetCurrentTime();
        case "schedule_tool": return _execScheduleTool(args, mcpRegistry);
        case "list_scheduled": return _execListScheduled();
        case "cancel_scheduled": return _execCancelScheduled(args);
        case "clear_completed_scheduled": return _execClearCompletedScheduled();
        case "stash_in_browser": return _execStashInBrowser(args);
        case "unstash_in_browser": return _execUnstashInBrowser(args);
        case "list_stashes_in_browser": return _execListStashesInBrowser();
        case "remove_stash_in_browser": return _execRemoveStashInBrowser(args);
        case "save_to_file": return _execSaveToFile(args);
        default: return { error: `Unknown tool: ${name}` };
      }
    };

    return await withTimeout(
      runBuiltinTool(),
      DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS * 1000,
      `Built-in tool timed out after ${DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS}s: ${name}`
    );
  } catch (e) {
    return {
      error: e.message,
      hint: "The operation failed."
    };
  }
}

function withTimeout(promise, timeoutMs, message = "Operation timed out") {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

/**
 * Build consistent timing metadata for browser state snapshots.
 */
function _buildCapturedAt() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

/**
 * Parse a base64 data URL and estimate its decoded byte size.
 */
function _parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mediaType, base64Data] = match;
  const padding = base64Data.endsWith("==") ? 2 : (base64Data.endsWith("=") ? 1 : 0);
  return {
    mediaType,
    base64Data,
    approxBytes: Math.max(0, Math.floor(base64Data.length * 3 / 4) - padding)
  };
}

/**
 * Resize and recompress screenshots so they are practical for multimodal tool results.
 *
 * @param {string} dataUrl
 * @param {{ strategy?: "fitMaxEdge" | "fitWidth", maxWidth?: number, maxHeight?: number, jpegQuality?: number }} [options]
 *   - fitMaxEdge (default): scale so max(width,height) <= 1600 (single-viewport shots).
 *   - fitWidth: only shrink when width exceeds maxWidth; keeps tall stitched pages readable (avoids crushing height).
 */
async function _optimizeScreenshotDataUrl(dataUrl, options = {}) {
  const parsed = _parseDataUrl(dataUrl);
  if (!parsed || typeof document === "undefined") {
    return {
      dataUrl,
      mediaType: parsed?.mediaType || "image/png",
      approxBytes: parsed?.approxBytes || null,
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      optimized: false
    };
  }

  const strategy = options.strategy === "fitWidth" ? "fitWidth" : "fitMaxEdge";
  const jpegQuality =
    typeof options.jpegQuality === "number"
      ? Math.min(1, Math.max(0.5, options.jpegQuality))
      : strategy === "fitWidth"
        ? 0.88
        : 0.7;

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });

    const originalWidth = img.naturalWidth || img.width || null;
    const originalHeight = img.naturalHeight || img.height || null;
    let scale = 1;
    if (originalWidth && originalHeight) {
      if (strategy === "fitWidth") {
        const maxW = Number.isFinite(options.maxWidth) ? Math.max(320, options.maxWidth) : 2048;
        const maxH = Number.isFinite(options.maxHeight) ? Math.max(800, options.maxHeight) : 24000;
        if (originalWidth > maxW) scale = maxW / originalWidth;
        const hAfter = originalHeight * scale;
        if (hAfter > maxH) scale *= maxH / hAfter;
        scale = Math.min(1, scale);
      } else {
        const maxDimension = 1600;
        scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));
      }
    }
    const width = originalWidth ? Math.max(1, Math.round(originalWidth * scale)) : null;
    const height = originalHeight ? Math.max(1, Math.round(originalHeight * scale)) : null;

    const canvas = document.createElement("canvas");
    canvas.width = width || img.width;
    canvas.height = height || img.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const optimizedDataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
    const optimizedParsed = _parseDataUrl(optimizedDataUrl);
    return {
      dataUrl: optimizedDataUrl,
      mediaType: optimizedParsed?.mediaType || "image/jpeg",
      approxBytes: optimizedParsed?.approxBytes || null,
      width: canvas.width,
      height: canvas.height,
      originalWidth,
      originalHeight,
      optimized: optimizedDataUrl.length < dataUrl.length || scale < 1
    };
  } catch (e) {
    return {
      dataUrl,
      mediaType: parsed.mediaType,
      approxBytes: parsed.approxBytes,
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      optimized: false
    };
  }
}

/**
 * Normalize Chrome's lastAccessed field for tool responses.
 */
function _buildLastAccessed(lastAccessed) {
  if (typeof lastAccessed !== "number") {
    return { lastAccessed: null, lastAccessedIso: null };
  }
  return {
    lastAccessed,
    lastAccessedIso: new Date(lastAccessed).toISOString()
  };
}

/**
 * Normalize Chrome's groupId field for tool responses.
 */
function _normalizeGroupId(groupId) {
  return typeof groupId === "number" && groupId >= 0 ? groupId : null;
}

/**
 * Serialize common tab metadata for tool responses.
 */
function _serializeTabMetadata(tab) {
  return {
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Serialize common tab group metadata for tool responses.
 */
function _serializeGroupMetadata(group, tabs = [], currentWindowId = null) {
  return {
    id: group.id,
    windowId: group.windowId,
    currentWindow: currentWindowId != null ? group.windowId === currentWindowId : null,
    title: group.title || "",
    color: group.color || "",
    collapsed: !!group.collapsed,
    tabCount: tabs.length,
    tabs: tabs.map(tab => _serializeTabMetadata(tab))
  };
}

/**
 * Load every tab group snapshot in one pass.
 */
async function _loadAllGroupSnapshots() {
  const [groups, tabs, currentWindow] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
    chrome.windows.getCurrent({})
  ]);

  const tabsByGroupId = new Map();
  for (const tab of tabs) {
    const groupId = _normalizeGroupId(tab.groupId);
    if (groupId == null) continue;
    if (!tabsByGroupId.has(groupId)) tabsByGroupId.set(groupId, []);
    tabsByGroupId.get(groupId).push(tab);
  }

  return groups.map(group => _serializeGroupMetadata(
    group,
    tabsByGroupId.get(group.id) || [],
    currentWindow?.id ?? null
  ));
}

/**
 * Load a single tab group snapshot by groupId.
 */
async function _loadGroupSnapshot(groupId) {
  const groups = await _loadAllGroupSnapshots();
  return groups.find(group => group.id === groupId) || null;
}

/**
 * Serialize common window metadata for tool responses.
 */
function _serializeWindowMetadata(win, currentWindowId = null) {
  return {
    id: win.id,
    focused: !!win.focused,
    current: currentWindowId != null ? win.id === currentWindowId : null,
    type: win.type || "",
    state: win.state || "",
    incognito: !!win.incognito,
    top: typeof win.top === "number" ? win.top : null,
    left: typeof win.left === "number" ? win.left : null,
    width: typeof win.width === "number" ? win.width : null,
    height: typeof win.height === "number" ? win.height : null,
    tabCount: Array.isArray(win.tabs) ? win.tabs.length : null,
    tabs: Array.isArray(win.tabs) ? win.tabs.map(tab => _serializeTabMetadata(tab)) : []
  };
}

/**
 * Get info about all currently open tabs.
 */
async function _execTabList({ maxSize = -1, briefUrl = false } = {}) {
  const capturedAt = _buildCapturedAt();
  let tabs = await chrome.tabs.query({});
  if (maxSize > 0) tabs = tabs.slice(0, maxSize);
  return {
    capturedAt,
    count: tabs.length,
    tabs: tabs.map(tab => {
      const meta = _serializeTabMetadata(tab);
      if (briefUrl) {
        try { meta.url = new URL(meta.url).hostname; } catch { /* keep original */ }
      }
      return meta;
    })
  };
}

/**
 * Resolve a controllable http(s) tab, defaulting to the current active tab.
 */
async function _resolveControllableTab(tabId, actionLabel = "control") {
  let resolvedTabId = tabId;
  if (resolvedTabId == null) {
    const activeTab = await _getActiveTabInCurrentExtensionWindow();
    if (!activeTab?.id) return { error: "No active tab found" };
    resolvedTabId = activeTab.id;
  }

  const tab = await chrome.tabs.get(resolvedTabId);
  if (!tab.url || !tab.url.startsWith("http")) {
    return { error: `Cannot ${actionLabel} this page (${tab.url?.split("://")[0] || "unknown"} protocol)` };
  }

  return { tab };
}

async function _getActiveTabInCurrentExtensionWindow() {
  const currentWindow = await _getCurrentExtensionWindow();
  if (currentWindow?.id != null) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
    if (tab?.id) return tab;
  }

  return null;
}

async function _getCurrentExtensionWindow() {
  try {
    return await chrome.windows.getCurrent({});
  } catch (_e) {
    return null;
  }
}

/**
 * Run a structured page action directly inside the target tab.
 */
async function _executePageAction(tab, action, params, failureHint) {
  try {
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (pageAction, pageParams) => {
        const TEXT_LIMIT = 500;
        const HTML_LIMIT = 4000;
        const HIGHLIGHT_STYLE_ID = "__tab_manager_highlight_style__";
        const HIGHLIGHT_OVERLAY_ID = "__tab_manager_highlight_overlay__";

        function sleep(ms) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }

        function truncateText(text, maxLength = TEXT_LIMIT) {
          const normalized = String(text || "").replace(/\s+/g, " ").trim();
          return normalized.length > maxLength ? normalized.slice(0, maxLength) + "..." : normalized;
        }

        function getScrollState() {
          const scroller = document.scrollingElement || document.documentElement || document.body;
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
          const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
          const documentHeight = Math.max(
            scroller?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0,
            document.body?.scrollHeight || 0
          );
          const documentWidth = Math.max(
            scroller?.scrollWidth || 0,
            document.documentElement?.scrollWidth || 0,
            document.body?.scrollWidth || 0
          );
          const scrollY = window.scrollY || scroller?.scrollTop || 0;
          const scrollX = window.scrollX || scroller?.scrollLeft || 0;
          const maxScrollY = Math.max(0, documentHeight - viewportHeight);
          const maxScrollX = Math.max(0, documentWidth - viewportWidth);

          return {
            url: document.URL,
            title: document.title,
            scrollX,
            scrollY,
            maxScrollX,
            maxScrollY,
            viewportWidth,
            viewportHeight,
            documentWidth,
            documentHeight,
            atTop: scrollY <= 0,
            atBottom: scrollY >= maxScrollY,
            atLeft: scrollX <= 0,
            atRight: scrollX >= maxScrollX
          };
        }

        function getSearchableText(element) {
          return truncateText([
            element.innerText,
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("placeholder"),
            element.getAttribute("alt"),
            element.getAttribute("value")
          ].filter(Boolean).join(" "), 2000).toLowerCase();
        }

        function isElementVisible(element) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          return rect.width > 0 && rect.height > 0;
        }

        function isElementClickable(element) {
          return Boolean(
            element.matches("a, button, input, select, textarea, summary, option, label") ||
            element.getAttribute("role") === "button" ||
            typeof element.onclick === "function"
          );
        }

        function serializeAttributes(element) {
          const importantNames = [
            "id",
            "class",
            "name",
            "type",
            "role",
            "href",
            "src",
            "placeholder",
            "aria-label",
            "for",
            "value"
          ];
          const attributes = {};

          for (const name of importantNames) {
            const value = element.getAttribute(name);
            if (value != null && value !== "") {
              attributes[name] = truncateText(value, 300);
            }
          }

          return attributes;
        }

        function serializeRect(element) {
          const rect = element.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            pageX: Math.round(rect.left + window.scrollX),
            pageY: Math.round(rect.top + window.scrollY)
          };
        }

        function serializeElement(element, index) {
          return {
            index,
            tagName: element.tagName.toLowerCase(),
            text: truncateText(element.innerText || element.textContent || ""),
            value: truncateText(element.value || "", 300),
            visible: isElementVisible(element),
            clickable: isElementClickable(element),
            attributes: serializeAttributes(element),
            rect: serializeRect(element)
          };
        }

        function findMatchingElements(locator) {
          if (!locator.selector && !locator.text) {
            return { error: "Please provide at least one locator: selector or text" };
          }

          let elements;
          try {
            elements = locator.selector
              ? Array.from(document.querySelectorAll(locator.selector))
              : Array.from(document.querySelectorAll("body *"));
          } catch (e) {
            return { error: `Invalid selector: ${e.message}` };
          }

          if (!locator.text) {
            return { elements };
          }

          const search = String(locator.text).trim().toLowerCase();
          const filtered = elements.filter(element => {
            const candidate = getSearchableText(element);
            return locator.matchExact ? candidate === search : candidate.includes(search);
          });

          return { elements: filtered };
        }

        function resolveElement(locator) {
          const { elements, error } = findMatchingElements(locator);
          if (error) return { error };

          const index = Number.isInteger(locator.index) ? locator.index : 0;
          if (index < 0 || index >= elements.length) {
            return {
              error: elements.length === 0
                ? "No matching element found"
                : `Element index out of range: ${index}. Available matches: ${elements.length}`
            };
          }

          return { element: elements[index], index, totalMatches: elements.length };
        }

        function ensureHighlightStyles() {
          if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
          const style = document.createElement("style");
          style.id = HIGHLIGHT_STYLE_ID;
          style.textContent = `
            @keyframes tab-manager-highlight-pulse {
              0%, 100% { opacity: 0.2; transform: scale(0.98); }
              50% { opacity: 1; transform: scale(1); }
            }
            #${HIGHLIGHT_OVERLAY_ID} {
              position: fixed;
              pointer-events: none;
              z-index: 2147483647;
              border: 3px solid #ff5f2e;
              background: rgba(255, 95, 46, 0.12);
              box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.08);
              border-radius: 10px;
              animation: tab-manager-highlight-pulse 0.3s ease-in-out 3;
            }
          `;
          document.documentElement.appendChild(style);
        }

        function clearHighlightOverlay() {
          document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
        }

        function showHighlightOverlay(element, durationMs) {
          clearHighlightOverlay();
          ensureHighlightStyles();

          const rect = element.getBoundingClientRect();
          const overlay = document.createElement("div");
          overlay.id = HIGHLIGHT_OVERLAY_ID;
          overlay.style.top = `${Math.max(0, rect.top - 6)}px`;
          overlay.style.left = `${Math.max(0, rect.left - 6)}px`;
          overlay.style.width = `${Math.max(8, rect.width + 12)}px`;
          overlay.style.height = `${Math.max(8, rect.height + 12)}px`;
          document.documentElement.appendChild(overlay);
          window.setTimeout(() => overlay.remove(), durationMs);
        }

        function setFormElementValue(element, value) {
          const tagName = element.tagName.toLowerCase();
          const stringValue = String(value ?? "");
          let setter = null;

          if (tagName === "input") {
            setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          } else if (tagName === "textarea") {
            setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          } else if (tagName === "select") {
            setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
          }

          if (setter) setter.call(element, stringValue);
          else element.value = stringValue;

          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }

        try {
          if (pageAction === "tab_scroll") {
            const stateBefore = getScrollState();
            const behavior = pageParams.behavior === "smooth" ? "smooth" : "auto";
            const position = typeof pageParams.position === "string" ? pageParams.position : null;
            let top = null;

            if (position === "top") top = 0;
            else if (position === "bottom") top = stateBefore.maxScrollY;
            else if (typeof pageParams.deltaY === "number" && Number.isFinite(pageParams.deltaY)) {
              top = stateBefore.scrollY + pageParams.deltaY;
            } else if (typeof pageParams.pageFraction === "number" && Number.isFinite(pageParams.pageFraction)) {
              top = stateBefore.scrollY + (stateBefore.viewportHeight * pageParams.pageFraction);
            } else {
              top = stateBefore.scrollY + stateBefore.viewportHeight * 0.8;
            }

            top = Math.max(0, Math.min(stateBefore.maxScrollY, top));
            window.scrollTo({ top, behavior });
            await sleep(behavior === "smooth" ? 400 : 60);
            const stateAfter = getScrollState();
            return {
              success: true,
              action: position || "delta",
              requestedTop: top,
              moved: Math.abs(stateAfter.scrollY - stateBefore.scrollY) > 1,
              before: stateBefore,
              after: stateAfter
            };
          }

          if (pageAction === "dom_query") {
            const maxResults = Math.min(20, Math.max(1, Number.isInteger(pageParams.maxResults) ? pageParams.maxResults : 5));
            const { elements, error } = findMatchingElements(pageParams);
            if (error) return { error };
            return {
              success: true,
              selector: pageParams.selector || null,
              text: pageParams.text || null,
              count: elements.length,
              truncated: elements.length > maxResults,
              matches: elements.slice(0, maxResults).map((element, index) => serializeElement(element, index))
            };
          }

          if (pageAction === "dom_click") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            if (typeof element.focus === "function") {
              try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            }
            await sleep(350);
            element.click();
            return {
              success: true,
              action: "click",
              totalMatches: resolved.totalMatches,
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_set_value") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            const tagName = element.tagName.toLowerCase();
            if (!["input", "textarea", "select"].includes(tagName)) {
              return { error: `Element is not a form field: <${tagName}>` };
            }
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            if (typeof element.focus === "function") {
              try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            }
            await sleep(350);
            setFormElementValue(element, pageParams.value);
            return {
              success: true,
              action: "set_value",
              totalMatches: resolved.totalMatches,
              value: truncateText(element.value || "", 500),
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_style") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            if (!pageParams.styles || typeof pageParams.styles !== "object" || Array.isArray(pageParams.styles)) {
              return { error: "Please provide a styles object" };
            }
            const durationMs = Math.min(10000, Math.max(0, Number.isFinite(pageParams.durationMs) ? pageParams.durationMs : 2000));
            const element = resolved.element;
            const previous = {};
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            for (const [key, value] of Object.entries(pageParams.styles)) {
              previous[key] = element.style[key];
              element.style[key] = String(value);
            }
            if (durationMs > 0) {
              window.setTimeout(() => {
                for (const [key, value] of Object.entries(previous)) {
                  element.style[key] = value;
                }
              }, durationMs);
            }
            return {
              success: true,
              action: "style",
              durationMs,
              styles: pageParams.styles,
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_get_html") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const mode = pageParams.mode === "inner" ? "inner" : "outer";
            const maxLength = Math.min(20000, Math.max(200, Number.isInteger(pageParams.maxLength) ? pageParams.maxLength : HTML_LIMIT));
            const element = resolved.element;
            const html = mode === "inner" ? element.innerHTML : element.outerHTML;
            return {
              success: true,
              mode,
              truncated: html.length > maxLength,
              html: html.length > maxLength ? html.slice(0, maxLength) + "..." : html,
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_highlight") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const durationMs = Math.min(5000, Math.max(300, Number.isFinite(pageParams.durationMs) ? pageParams.durationMs : 1000));
            const element = resolved.element;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            await sleep(350);
            showHighlightOverlay(element, durationMs);
            return {
              success: true,
              action: "highlight",
              durationMs,
              target: serializeElement(element, resolved.index),
              scroll: getScrollState()
            };
          }

          return { error: `Unknown page action: ${pageAction}` };
        } catch (error) {
          return { error: error.message || String(error) };
        }
      },
      args: [action, params]
    });

    const results = await Promise.race([
      scriptPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for page response")), 12000))
    ]);

    const data = results?.[0]?.result;
    if (!data) return { error: "Page action did not return a result" };
    if (data.error) return { error: data.error, hint: failureHint };

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: _normalizeGroupId(tab.groupId),
      ..._buildLastAccessed(tab.lastAccessed),
      ...data
    };
  } catch (e) {
    return {
      error: e.message,
      hint: failureHint
    };
  }
}

/**
 * Extract text content from a browser tab via content script.
 */
async function _execTabExtract({ tabId }) {
  const resolved = await _resolveControllableTab(tabId, "read");
  if (resolved.error) return { error: resolved.error };
  try {
    const { extractTextLimit = 8000 } = await chrome.storage.local.get({ extractTextLimit: 8000 });
    const limit = Number(extractTextLimit) || 8000;
    const results = await chrome.scripting.executeScript({
      target: { tabId: resolved.tab.id },
      func: (maxLen) => {
        const textSource =
          document.body?.innerText ||
          document.documentElement?.innerText ||
          document.body?.textContent ||
          document.documentElement?.textContent ||
          "";
        return {
          url: document.URL,
          title: document.title,
          content: String(textSource).substring(0, maxLen)
        };
      },
      args: [limit]
    });

    const data = results?.[0]?.result;
    if (!data) {
      return { error: "Failed to extract tab content" };
    }

    return {
      ...data,
      tabId: resolved.tab.id,
      windowId: resolved.tab.windowId,
      groupId: _normalizeGroupId(resolved.tab.groupId),
      ..._buildLastAccessed(resolved.tab.lastAccessed)
    };
  } catch (e) {
    return {
      error: e.message,
      hint: "This page may need to be refreshed before its content can be read."
    };
  }
}

/**
 * Scroll a browser tab and return the updated scroll state.
 */
async function _execTabScroll({ tabId, deltaY, pageFraction, position, behavior }) {
  const resolved = await _resolveControllableTab(tabId, "scroll");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "tab_scroll",
    { deltaY, pageFraction, position, behavior },
    "This page may need to be refreshed before scrolling can be controlled."
  );
}

/**
 * Query matching DOM elements on a page.
 */
async function _execDomQuery({ tabId, selector, text, matchExact, maxResults }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_query",
    { selector, text, matchExact, maxResults },
    "This page may need to be refreshed before DOM inspection can run."
  );
}

/**
 * Click a matching DOM element on a page.
 */
async function _execDomClick({ tabId, selector, text, matchExact, index }) {
  const resolved = await _resolveControllableTab(tabId, "interact with");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_click",
    { selector, text, matchExact, index },
    "This page may need to be refreshed before DOM interactions can run."
  );
}

/**
 * Set the value of a form field on a page.
 */
async function _execDomSetValue({ tabId, selector, text, matchExact, index, value }) {
  const resolved = await _resolveControllableTab(tabId, "edit");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_set_value",
    { selector, text, matchExact, index, value },
    "This page may need to be refreshed before form fields can be edited."
  );
}

/**
 * Temporarily style a DOM element on a page.
 */
async function _execDomStyle({ tabId, selector, text, matchExact, index, styles, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "style");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_style",
    { selector, text, matchExact, index, styles, durationMs },
    "This page may need to be refreshed before styles can be modified."
  );
}

/**
 * Get HTML from a matched DOM element on a page.
 */
async function _execDomGetHtml({ tabId, selector, text, matchExact, index, mode, maxLength }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_get_html",
    { selector, text, matchExact, index, mode, maxLength },
    "This page may need to be refreshed before DOM HTML can be read."
  );
}

/**
 * Scroll to and visually highlight a DOM element on the page.
 */
async function _execDomHighlight({ tabId, selector, text, matchExact, index, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "highlight");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_highlight",
    { selector, text, matchExact, index, durationMs },
    "This page may need to be refreshed before highlighting can run."
  );
}

/**
 * Execute arbitrary JavaScript on the current page.
 * Dangerous: should only be reached after explicit user approval.
 */
async function _execEvalJs({ jsScript }) {
  const resolved = await _resolveControllableTab(undefined, "run code on");
  if (resolved.error) return { error: resolved.error };

  const world = "MAIN";
  try {
    const runnerFunc = async (source) => {
      const channel = `__tab_manager_eval_js_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return await new Promise((resolve) => {
        let settled = false;

        function finish(payload) {
          if (settled) return;
          settled = true;
          window.removeEventListener(channel, onResult);
          resolve(payload);
        }

        function onResult(event) {
          finish(event?.detail || { error: "No result returned from injected script" });
        }

        window.addEventListener(channel, onResult, { once: true });

        const script = document.createElement("script");
        script.type = "text/javascript";
        script.textContent = `
          (async () => {
            const channel = ${JSON.stringify(channel)};
            function normalizeResult(value) {
              if (value === undefined) return { kind: "undefined", value: null };
              if (value === null) return null;
              try {
                const json = JSON.stringify(value);
                if (json === undefined) {
                  return { kind: typeof value, value: String(value) };
                }
                return JSON.parse(json);
              } catch (e) {
                return { kind: typeof value, value: String(value) };
              }
            }

            try {
              const result = await (async () => {
                ${source}
              })();
              window.dispatchEvent(new CustomEvent(channel, {
                detail: {
                  success: true,
                  url: document.URL,
                  title: document.title,
                  result: normalizeResult(result)
                }
              }));
            } catch (error) {
              window.dispatchEvent(new CustomEvent(channel, {
                detail: {
                  error: error && error.message ? error.message : String(error),
                  stack: error && error.stack ? String(error.stack).slice(0, 4000) : null,
                  url: document.URL,
                  title: document.title
                }
              }));
            }
          })();
        `;

        const parent = document.documentElement || document.head || document.body;
        if (!parent) {
          finish({ error: "Unable to inject script into this page" });
          return;
        }

        parent.appendChild(script);
        script.remove();

        setTimeout(() => {
          finish({
            error: "Injected script did not return a result. It may have been blocked by the page CSP.",
            url: document.URL,
            title: document.title
          });
        }, 11000);
      });
    };

    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: resolved.tab.id },
        world,
        func: runnerFunc,
        args: [jsScript]
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for JavaScript execution")), 12000);
      })
    ]);

    const data = results?.[0]?.result;
    if (!data) return { error: "No result returned from JavaScript execution" };

    return {
      world,
      tabId: resolved.tab.id,
      windowId: resolved.tab.windowId,
      groupId: _normalizeGroupId(resolved.tab.groupId),
      ..._buildLastAccessed(resolved.tab.lastAccessed),
      ...data
    };
  } catch (e) {
    return {
      error: e.message,
      world,
      hint: "The script could not be executed on this page."
    };
  }
}

/**
 * Open a new tab with the given URL. Optionally focus on it.
 */
async function _execTabOpen({ url, active }) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const shouldFocus = active !== false; // default true
  const tab = await chrome.tabs.create({ url, active: shouldFocus });
  if (shouldFocus) await chrome.windows.update(tab.windowId, { focused: true });
  return {
    success: true,
    active: shouldFocus,
    tabId: tab.id,
    url: tab.pendingUrl || tab.url || url,
    title: tab.title || "",
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Switch focus to an existing tab.
 */
async function _execTabFocus({ tabId }) {
  let tab = await chrome.tabs.get(tabId);
  const currentWindow = await chrome.windows.getCurrent({});
  const previousWindowId = tab.windowId;
  let movedToCurrentWindow = false;

  if (currentWindow?.id && tab.windowId !== currentWindow.id) {
    tab = await chrome.tabs.move(tabId, { windowId: currentWindow.id, index: -1 });
    movedToCurrentWindow = true;
  }

  tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return {
    success: true,
    tabId,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    previousWindowId,
    movedToCurrentWindow,
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Close one or more tabs.
 */
async function _execTabClose({ tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  // Collect tab titles before closing
  const closed = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      closed.push(_serializeTabMetadata(tab));
    } catch (e) {
      closed.push({ id, error: "Tab not found" });
    }
  }
  await chrome.tabs.remove(ids.filter(id => closed.find(c => c.id === id && !c.error)));
  return { success: true, closed };
}

/**
 * Group tabs together with a name and optional color.
 */
async function _execTabGroup({ tabIds, name, color }) {
  const groupId = await chrome.tabs.group({ tabIds });
  const updateProps = { title: name };
  if (color) updateProps.color = color;
  await chrome.tabGroups.update(groupId, updateProps);
  const group = await _loadGroupSnapshot(groupId);
  return { success: true, groupId, name, tabCount: tabIds.length, group };
}

/**
 * Get info about all current tab groups.
 */
async function _execGroupList() {
  const capturedAt = _buildCapturedAt();
  const groups = await _loadAllGroupSnapshots();
  return {
    capturedAt,
    count: groups.length,
    groups
  };
}

/**
 * Get info about a specific tab group.
 */
async function _execGroupGet({ groupId }) {
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found: ${groupId}` };
  return {
    capturedAt: _buildCapturedAt(),
    group
  };
}

/**
 * Update a tab group's title, color, or collapsed state.
 */
async function _execGroupUpdate({ groupId, name, color, collapsed }) {
  const updateProps = {};
  if (name != null) updateProps.title = name;
  if (color != null) updateProps.color = color;
  if (collapsed != null) updateProps.collapsed = collapsed;

  if (Object.keys(updateProps).length === 0) {
    return { error: "Please provide at least one field to update: name, color, or collapsed" };
  }

  await chrome.tabGroups.update(groupId, updateProps);
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found after update: ${groupId}` };
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    group
  };
}

/**
 * Add tabs to an existing tab group.
 */
async function _execGroupAddTabs({ groupId, tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  await chrome.tabs.group({ groupId, tabIds: ids });
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found after adding tabs: ${groupId}` };
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    groupId,
    addedCount: ids.length,
    group
  };
}

/**
 * Remove tabs from their current tab groups.
 */
async function _execGroupRemoveTabs({ tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const beforeTabs = [];

  for (const id of ids) {
    try {
      beforeTabs.push(await chrome.tabs.get(id));
    } catch (e) {
      beforeTabs.push({ id, error: "Tab not found" });
    }
  }

  const validTabIds = beforeTabs.filter(tab => !tab.error).map(tab => tab.id);
  if (validTabIds.length > 0) {
    await chrome.tabs.ungroup(validTabIds);
  }

  const afterTabs = await Promise.all(validTabIds.map(async (id) => {
    try {
      return await chrome.tabs.get(id);
    } catch (e) {
      return null;
    }
  }));

  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    requestedCount: ids.length,
    updatedCount: afterTabs.filter(Boolean).length,
    tabs: afterTabs.filter(Boolean).map(tab => _serializeTabMetadata(tab)),
    missing: beforeTabs.filter(tab => tab.error).map(tab => ({ id: tab.id, error: tab.error }))
  };
}

/**
 * Dissolve an entire tab group.
 */
async function _execGroupUngroup({ groupId }) {
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found: ${groupId}` };

  const tabIds = group.tabs.map(tab => tab.id).filter(id => typeof id === "number");
  if (tabIds.length > 0) {
    await chrome.tabs.ungroup(tabIds);
  }

  const tabs = await Promise.all(tabIds.map(async (id) => {
    try {
      return await chrome.tabs.get(id);
    } catch (e) {
      return null;
    }
  }));

  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    groupId,
    ungroupedCount: tabIds.length,
    group,
    tabs: tabs.filter(Boolean).map(tab => _serializeTabMetadata(tab))
  };
}

/**
 * Search browser history by keyword.
 */
async function _execHistorySearch({ query, maxResults }) {
  const results = await chrome.history.search({
    text: query,
    maxResults: maxResults || 10,
    startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 // last 30 days
  });
  return results.map(r => ({
    url: r.url,
    title: r.title,
    lastVisit: new Date(r.lastVisitTime).toISOString(),
    visitCount: r.visitCount
  }));
}

/**
 * List recent browser history within a time range.
 */
async function _execHistoryRecent({ startTime, endTime, maxResults }) {
  const now = Date.now();
  const resolvedEndTime = Number.isFinite(endTime) ? endTime : now;
  const resolvedStartTime = Number.isFinite(startTime)
    ? startTime
    : (resolvedEndTime - 7 * 24 * 60 * 60 * 1000);
  const resolvedMaxResults = Math.min(100, Math.max(1, Number.isFinite(maxResults) ? Math.floor(maxResults) : 100));

  if (resolvedStartTime > resolvedEndTime) {
    return { error: "startTime must be less than or equal to endTime" };
  }

  const results = await chrome.history.search({
    text: "",
    maxResults: resolvedMaxResults,
    startTime: resolvedStartTime,
    endTime: resolvedEndTime
  });

  return {
    startTime: new Date(resolvedStartTime).toISOString(),
    endTime: new Date(resolvedEndTime).toISOString(),
    maxResults: resolvedMaxResults,
    results: results.map(r => ({
      url: r.url,
      title: r.title,
      lastVisit: new Date(r.lastVisitTime).toISOString(),
      visitCount: r.visitCount
    }))
  };
}

/**
 * Get info about the active tab in the current extension window.
 */
async function _execTabGetActive() {
  const capturedAt = _buildCapturedAt();
  const tab = await _getActiveTabInCurrentExtensionWindow();
  if (!tab) return { error: "No active tab found" };
  return {
    capturedAt,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

function _sleepMs(ms) {
  const n = Math.max(0, Math.floor(ms));
  if (!n) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}


/**
 * Convert a Blob to a base64 data URL (works in both DOM and Service Worker contexts).
 */
async function _blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return "data:" + (blob.type || "image/png") + ";base64," + btoa(binary);
}

/**
 * so they don't overlap content in subsequent full-page screenshot tiles.
 * Stores the original display value in a data attribute for later restoration.
 */
async function _hideStickyHeaderElements(tab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const hidden = [];
        const all = document.querySelectorAll("*");
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        // Only consider elements in the top 30% of the viewport, up to 300px max.
        const topThreshold = Math.min(300, Math.max(80, vh * 0.3));

        for (const el of all) {
          const style = window.getComputedStyle(el);
          const pos = style.position;
          if (pos !== "fixed" && pos !== "sticky") continue;

          const rect = el.getBoundingClientRect();
          // Element must be near the top of the viewport and have some visible height.
          if (rect.top < topThreshold && rect.bottom > 0 && rect.height > 0) {
            const origDisplay = style.display;
            el.setAttribute("data-tabmgr-screenshot-hidden", origDisplay);
            el.style.setProperty("display", "none", "important");
            hidden.push(
              el.tagName.toLowerCase() +
                (el.id ? "#" + el.id : "") +
                (el.className && typeof el.className === "string"
                  ? "." + el.className.trim().split(/\s+/)[0]
                  : "")
            );
          }
        }
        return hidden;
      }
    });
  } catch (_e) {
    // Non-fatal: sticky headers may remain visible but the screenshot is still valid.
    return [];
  }
}

/**
 * Restore elements that were hidden by _hideStickyHeaderElements.
 * Removes the tracking attribute and restores the original display style.
 */
async function _restoreStickyElements(tab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const hidden = document.querySelectorAll("[data-tabmgr-screenshot-hidden]");
        for (const el of hidden) {
          const origDisplay = el.getAttribute("data-tabmgr-screenshot-hidden");
          el.style.removeProperty("display");
          if (origDisplay && origDisplay !== "none") {
            el.style.display = origDisplay;
          }
          el.removeAttribute("data-tabmgr-screenshot-hidden");
        }
      }
    });
  } catch (_e) {
    // Best-effort restoration; non-fatal.
  }
}

async function _readPageScrollMetrics(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const scroller = document.scrollingElement || document.documentElement || document.body;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const documentHeight = Math.max(
          scroller?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
        const scrollY = window.scrollY || scroller?.scrollTop || 0;
        const maxScrollY = Math.max(0, documentHeight - viewportHeight);
        return {
          viewportHeight,
          viewportWidth,
          documentHeight,
          scrollY,
          maxScrollY,
          atBottom: scrollY >= maxScrollY - 1.5
        };
      }
    });
    return results?.[0]?.result || null;
  } catch (_e) {
    return null;
  }
}

async function _setPageScrollTop(tab, top) {
  const y = Math.max(0, Number(top) || 0);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (scrollTop) => {
      window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
    },
    args: [y]
  });
}

async function _readInnerHeightAndScrollY(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const scroller = document.scrollingElement || document.documentElement || document.body;
        const innerHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const documentHeight = Math.max(
          scroller?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
        const scrollY = window.scrollY || scroller?.scrollTop || 0;
        const maxScrollY = Math.max(0, documentHeight - innerHeight);
        return { innerHeight, scrollY, maxScrollY, documentHeight };
      }
    });
    return results?.[0]?.result || null;
  } catch (_e) {
    return null;
  }
}

async function _loadImageFromDataUrl(dataUrl) {
  if (typeof createImageBitmap === "function") {
    const parsed = _parseDataUrl(dataUrl);
    if (!parsed) throw new Error("Invalid screenshot data URL");
    const byteString = atob(dataUrl.split(",")[1] || "");
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    const blob = new Blob([bytes], { type: parsed.mediaType || "image/png" });
    return await createImageBitmap(blob);
  }

  if (typeof Image !== "undefined") {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to decode screenshot image"));
      image.src = dataUrl;
    });
  }

  throw new Error("No browser image decoder is available in this context");
}

const FULL_PAGE_MAX_STITCH_PX = 16000;
/** When true, draws a 2px red bar at each new tile boundary (top of stitched segment) for debugging. */
const FULL_PAGE_STITCH_DEBUG_BORDER = false;

/**
 * Capture a screenshot of the currently visible tab (viewport), or full scroll height when fullPage is true.
 * Returns an optimized base64 image data URL.
 */
async function _execTabScreenshot(args = {}) {
  const {
    windowId,
    tabId,
    fullPage,
    maxScreens: maxScreensRaw,
    settleMs: settleMsRaw
  } = args;

  const resolved = await _resolveControllableTab(tabId, "screenshot");
  if (resolved.error) return { error: resolved.error };

  const tab = resolved.tab;
  const wid = typeof windowId === "number" ? windowId : tab.windowId;

  const maxScreens = Number.isFinite(maxScreensRaw) ? Math.max(1, Math.min(100, Math.floor(maxScreensRaw))) : 40;
  const settleMs = Number.isFinite(settleMsRaw) ? Math.max(0, Math.min(5000, settleMsRaw)) : 250;

  const isFullPage = fullPage === true;

  const baseNote = isFullPage
    ? "Full-page stitch: tab window was focused; scroll position restored when possible."
    : "Optimized screenshot of the visible tab.";

  if (!isFullPage) {
    try {
      if (tabId != null) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await _sleepMs(80);
      }
      const rawDataUrl = await chrome.tabs.captureVisibleTab(wid, { format: "png" });
      const optimized = await _optimizeScreenshotDataUrl(rawDataUrl);
      return {
        success: true,
        fullPage: false,
        tabId: tab.id,
        windowId: tab.windowId,
        dataUrl: optimized.dataUrl,
        format: optimized.mediaType.split("/")[1] || "jpeg",
        mediaType: optimized.mediaType,
        approxBytes: optimized.approxBytes,
        width: optimized.width,
        height: optimized.height,
        originalWidth: optimized.originalWidth,
        originalHeight: optimized.originalHeight,
        optimized: optimized.optimized,
        note: baseNote
      };
    } catch (e) {
      return {
        error: e?.message || String(e),
        hint: "captureVisibleTab requires the target tab to be active in its window. Pass tabId to focus that tab first."
      };
    }
  }

  const m0 = await _readPageScrollMetrics(tab);
  if (!m0) {
    return { error: "Unable to read scroll metrics for full-page screenshot." };
  }
  const initialScrollY = m0.scrollY;

  let stoppedReason = "completed";
  let canvas = null;
  let ctx = null;
  let destY = 0;
  let slicesDrawn = 0;
  let exitedCaptureLoopEarly = false;

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await _sleepMs(80);

    await _setPageScrollTop(tab, 0);
    if (settleMs) await _sleepMs(settleMs);

    const hi0 = await _readInnerHeightAndScrollY(tab);
    if (!hi0) {
      return { error: "Unable to read innerHeight/scrollY for full-page screenshot." };
    }

    const windowHeight = Math.max(1, Math.round(hi0.innerHeight));
    let lastScrollAfterStitch = hi0.scrollY;

    /** Chrome throttles captureVisibleTab (~2/sec); stay under quota between real captures. */
    const MIN_CAPTURE_GAP_MS = 650;
    let lastCaptureAtMs = 0;

    // eslint-disable-next-line no-inner-declarations
    async function captureVisibleThrottled() {
      const now = Date.now();
      if (lastCaptureAtMs > 0) {
        const waitMs = MIN_CAPTURE_GAP_MS - (now - lastCaptureAtMs);
        if (waitMs > 0) await _sleepMs(waitMs);
      }
      const url = await chrome.tabs.captureVisibleTab(wid, { format: "png" });
      lastCaptureAtMs = Date.now();
      return url;
    }

    const layoutAfterTop = await _readPageScrollMetrics(tab);
    const documentHeight = Math.max(windowHeight, layoutAfterTop?.documentHeight ?? windowHeight);

    const raw0 = await captureVisibleThrottled();
    const img0 = await _loadImageFromDataUrl(raw0);
    const iw0 = img0.naturalWidth || img0.width;
    const ih0 = img0.naturalHeight || img0.height;

    const estRows = Math.ceil(documentHeight / windowHeight);
    canvas = new OffscreenCanvas(iw0, Math.min(FULL_PAGE_MAX_STITCH_PX, Math.max(ih0, Math.ceil(estRows * ih0))));
    ctx = canvas.getContext("2d");
    if (!ctx) {
      return { error: "2D canvas context unavailable for full-page stitch." };
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img0, 0, 0);
    destY = ih0;
    slicesDrawn = 1;

    // Sticky headers will be hidden before each subsequent scroll-position
    // screenshot inside the loop (elements may become sticky only after scrolling).
    let n = 1;
    while (slicesDrawn < maxScreens) {
      await _setPageScrollTop(tab, n * windowHeight);
      if (settleMs) await _sleepMs(settleMs);

      // Elements may gain position:fixed/sticky only after scrolling (e.g. headers
      // that stick after passing a threshold). Re-scan and hide before each capture.
      // Duplicates are harmless — the DOM data attribute prevents double-hiding.
      await _hideStickyHeaderElements(tab);

      const st = await _readInnerHeightAndScrollY(tab);
      if (!st) {
        stoppedReason = "metrics_failed";
        exitedCaptureLoopEarly = true;
        break;
      }
      const vh = Math.max(1, Math.round(st.innerHeight));
      const sy = st.scrollY;
      const targetY = n * windowHeight;
      const maxScrollY = Math.max(0, Number(st.maxScrollY) || 0);
      /**
       * The scroll position did not reach the requested target — browser has clamped
       * us at the bottom of the document, so this is the last screenshot tile.
       */
      const didNotReachTarget = sy < targetY - 0.5;

      /**
       * True only when scrollY is pinned near maxScrollY (symmetric band).
       * Using only sy >= maxScrollY - eps breaks when maxScrollY is underestimated (lazy layout):
       * sy can already be far below a too-small maxScrollY, falsely looking "at bottom".
       */
      const EPS_PIN = 24;
      const pinnedToMetricsBottom =
        maxScrollY > 0 && Number.isFinite(sy) && Math.abs(sy - maxScrollY) <= EPS_PIN;
      /** Requested scroll target lies past the furthest scrollable Y — browser clamped, this tile needs bottom crop. */
      const requestPastDocumentEnd = targetY > maxScrollY + 0.5;

      if (sy <= lastScrollAfterStitch + 0.5) {
        stoppedReason = "completed";
        exitedCaptureLoopEarly = true;
        break;
      }

      // True last page: browser has clamped us at the document bottom.
      // didNotReachTarget alone is NOT enough — we must also be pinned near maxScrollY;
      // otherwise the scroll was just partially blocked (lazy load, scroll-snap, etc.)
      // and we should keep going rather than cropping incorrectly.
      const isLastPage =
        maxScrollY > 0 &&
        pinnedToMetricsBottom &&
        (requestPastDocumentEnd || didNotReachTarget);

      const rawDataUrl = await captureVisibleThrottled();
      const img = await _loadImageFromDataUrl(rawDataUrl);
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;

      let safeCropTop = 0;
      if (isLastPage) {
        // How far the scroll actually advanced from the previous screenshot position.
        // This equals the non-overlapping (unique) content height in document pixels.
        const uniqueDocPx = Math.max(0, sy - (n - 1) * windowHeight);
        const keepDocPx = Math.min(vh, uniqueDocPx);
        // Crop the overlap from the TOP of the image, keep the bottom keepDocPx portion.
        const cropFromTop = Math.round(ih - (keepDocPx / vh) * ih);
        safeCropTop = Math.min(Math.max(0, cropFromTop), Math.max(0, ih - 1));
      }

      const sliceH = ih - safeCropTop;

      if (destY + sliceH > FULL_PAGE_MAX_STITCH_PX) {
        stoppedReason = "max_canvas";
        exitedCaptureLoopEarly = true;
        break;
      }

      if (destY + sliceH > canvas.height) {
        const newH = Math.min(
          FULL_PAGE_MAX_STITCH_PX,
          Math.max(destY + sliceH, Math.ceil(canvas.height * 1.5))
        );
        if (newH < destY + sliceH) {
          stoppedReason = "max_canvas";
          exitedCaptureLoopEarly = true;
          break;
        }
        const newCanvas = new OffscreenCanvas(canvas.width, newH);
        const nctx = newCanvas.getContext("2d");
        if (!nctx) {
          return { error: "2D canvas context unavailable while resizing stitch canvas." };
        }
        nctx.fillStyle = "#ffffff";
        nctx.fillRect(0, 0, newCanvas.width, newCanvas.height);
        nctx.drawImage(canvas, 0, 0);
        canvas = newCanvas;
        ctx = nctx;
      }

      if (FULL_PAGE_STITCH_DEBUG_BORDER && slicesDrawn > 0 && destY > 0) {
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, destY, canvas.width, 2);
      }

      ctx.drawImage(img, 0, safeCropTop, iw, sliceH, 0, destY, canvas.width, sliceH);
      destY += sliceH;
      slicesDrawn++;
      lastScrollAfterStitch = sy;

      if (isLastPage) {
        stoppedReason = "completed";
        exitedCaptureLoopEarly = true;
        break;
      }
      n++;
    }

    if (slicesDrawn === 0) {
      return {
        error: "No screenshots captured for full page.",
        hint: "Try a normal http(s) page with a scrollable document."
      };
    }

    if (
      !exitedCaptureLoopEarly &&
      stoppedReason === "completed" &&
      maxScreens > 1 &&
      slicesDrawn >= maxScreens
    ) {
      stoppedReason = "max_screens";
    }

    // Restore sticky elements that were hidden during the capture process.
    // Best-effort; failures are non-fatal to the screenshot result.
    await _restoreStickyElements(tab);

    const lastMetrics = await _readPageScrollMetrics(tab);
    const trimmed = new OffscreenCanvas(canvas.width, destY);
    const tctx = trimmed.getContext("2d");
    if (!tctx) {
      return { error: "Unable to finalize full-page canvas." };
    }
    tctx.drawImage(canvas, 0, 0);

    const stitchedPngBlob = await trimmed.convertToBlob({ type: "image/png" });
    const stitchedPng = await _blobToDataUrl(stitchedPngBlob);
    // Skip DOM-based optimization in Service Worker context (no document/Image available).
    // OffscreenCanvas convertToBlob already produces a compact PNG; the optional JPEG
    // recompress step only runs when a DOM environment is present.
    const optimized = typeof document === "undefined"
      ? {
          dataUrl: stitchedPng,
          mediaType: "image/png",
          approxBytes: Math.round(stitchedPng.length * 3 / 4),
          width: trimmed.width,
          height: trimmed.height,
          originalWidth: trimmed.width,
          originalHeight: trimmed.height,
          optimized: false
        }
      : await _optimizeScreenshotDataUrl(stitchedPng, {
          strategy: "fitWidth",
          maxWidth: 2048,
          maxHeight: 24000,
          jpegQuality: 0.88
        });

    return {
      success: true,
      fullPage: true,
      tabId: tab.id,
      windowId: tab.windowId,
      slices: slicesDrawn,
      stoppedReason,
      stitchMode: "pageAligned",
      pageViewportCssPx: windowHeight,
      maxScreens,
      settleMs,
      stitchedWidth: trimmed.width,
      stitchedHeight: trimmed.height,
      documentHeight: lastMetrics?.documentHeight ?? null,
      dataUrl: optimized.dataUrl,
      format: optimized.mediaType.split("/")[1] || "jpeg",
      mediaType: optimized.mediaType,
      approxBytes: optimized.approxBytes,
      width: optimized.width,
      height: optimized.height,
      originalWidth: optimized.originalWidth,
      originalHeight: optimized.originalHeight,
      optimized: optimized.optimized,
      note: baseNote
    };
  } catch (e) {
    return {
      error: e?.message || String(e),
      hint: "Full-page capture failed. Ensure the page allows scripting and the tab stays active."
    };
  } finally {
    try {
      await _setPageScrollTop(tab, initialScrollY);
    } catch (_e) {
      /* ignore */
    }
    try {
      await _restoreStickyElements(tab);
    } catch (_e) {
      /* ignore */
    }
  }
}

/**
 * Get info about all browser windows.
 */
async function _execWindowList() {
  const capturedAt = _buildCapturedAt();
  const [windows, currentWindow] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.windows.getCurrent({})
  ]);
  return {
    capturedAt,
    count: windows.length,
    currentWindowId: currentWindow?.id ?? null,
    windows: windows.map(win => _serializeWindowMetadata(win, currentWindow?.id ?? null))
  };
}

/**
 * Get info about the current browser window.
 */
async function _execWindowGetCurrent() {
  const capturedAt = _buildCapturedAt();
  const win = await chrome.windows.getCurrent({ populate: true });
  return {
    capturedAt,
    window: _serializeWindowMetadata(win, win.id)
  };
}

/**
 * Focus a browser window by ID.
 */
async function _execWindowFocus({ windowId }) {
  const previousWindow = await chrome.windows.getCurrent({});
  await chrome.windows.update(windowId, { focused: true });
  const focusedWindow = await chrome.windows.get(windowId, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    previousWindowId: previousWindow?.id ?? null,
    window: _serializeWindowMetadata(focusedWindow, windowId)
  };
}

/**
 * Move one or more tabs into a target window.
 */
async function _execWindowMoveTab({ tabIds, windowId }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const moved = await chrome.tabs.move(ids, { windowId, index: -1 });
  const movedTabs = Array.isArray(moved) ? moved : [moved];
  const currentWindow = await chrome.windows.getCurrent({});
  const targetWindow = await chrome.windows.get(windowId, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    windowId,
    movedCount: movedTabs.length,
    movedTabs: movedTabs.map(tab => _serializeTabMetadata(tab)),
    window: _serializeWindowMetadata(targetWindow, currentWindow?.id ?? null)
  };
}

/**
 * Create a new browser window.
 */
async function _execWindowCreate({ url, focused }) {
  const createData = {};
  if (url) createData.url = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  if (focused != null) createData.focused = focused;

  const createdWindow = await chrome.windows.create(createData);
  const win = await chrome.windows.get(createdWindow.id, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    window: _serializeWindowMetadata(win, win.id)
  };
}

/**
 * Close a browser window by ID.
 */
async function _execWindowClose({ windowId }) {
  const currentWindow = await chrome.windows.getCurrent({});
  const win = await chrome.windows.get(windowId, { populate: true });
  const snapshot = _serializeWindowMetadata(win, currentWindow?.id ?? null);
  await chrome.windows.remove(windowId);
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    closedWindowId: windowId,
    window: snapshot
  };
}

/**
 * Get current date, time, timezone and unix timestamp.
 */
function _execGetCurrentTime() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: now.getTimezoneOffset()
  };
}

function _snapshotScheduleMcpRegistry(mcpRegistry = []) {
  return (mcpRegistry || []).map(tool => ({
    name: tool?.name,
    _serverName: tool?._serverName,
    _serverUrl: tool?._serverUrl,
    _serverHeaders: tool?._serverHeaders || {},
    _toolCallName: tool?._toolCallName || buildMcpToolCallName(tool?._serverName || "server", tool?.name)
  })).filter(tool => tool.name && tool._toolCallName && tool._serverUrl);
}

function _isTerminalScheduledStatus(status) {
  return TERMINAL_SCHEDULE_STATUSES.has(status);
}

function _buildScheduleFireAlarmName(scheduleId) {
  return `${SCHEDULE_FIRE_ALARM_PREFIX}${scheduleId}`;
}

function _buildScheduleCleanupAlarmName(scheduleId) {
  return `${SCHEDULE_CLEANUP_ALARM_PREFIX}${scheduleId}`;
}

async function _loadScheduledJobsFromStorage() {
  const { [SCHEDULE_STORAGE_KEY]: jobs } = await chrome.storage.local.get({ [SCHEDULE_STORAGE_KEY]: [] });
  return Array.isArray(jobs) ? jobs : [];
}

async function _saveScheduledJobsToStorage(jobs) {
  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: jobs });
}

async function _clearScheduledAlarms(scheduleId) {
  if (!chrome.alarms) return;
  await chrome.alarms.clear(_buildScheduleFireAlarmName(scheduleId));
  await chrome.alarms.clear(_buildScheduleCleanupAlarmName(scheduleId));
}

function _serializeScheduledJob(job) {
  const remainingSeconds = job.status === "pending"
    ? Math.max(0, Math.round((job.fireTimestamp - Date.now()) / 1000))
    : 0;

  return {
    id: job.id,
    scheduleId: job.id,
    label: job.label,
    toolName: job.toolName,
    toolArgs: job.toolArgs,
    fireAt: new Date(job.fireTimestamp).toLocaleString(),
    status: job.status,
    remainingSeconds,
    timeoutSeconds: Math.round((job.executeTimeoutMs || (DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS * 1000)) / 1000),
    startedAt: job.startedAt ? new Date(job.startedAt).toLocaleString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toLocaleString() : null,
    error: job.error || null,
    expiresAt: job.expiresAt ? new Date(job.expiresAt).toLocaleString() : null
  };
}

async function _pruneExpiredScheduledJobsInStorage() {
  const jobs = await _loadScheduledJobsFromStorage();
  const now = Date.now();
  const kept = [];

  for (const job of jobs) {
    if (_isTerminalScheduledStatus(job?.status) && Number.isFinite(job?.expiresAt) && job.expiresAt <= now) {
      await _clearScheduledAlarms(job.id);
      continue;
    }
    kept.push(job);
  }

  if (kept.length !== jobs.length) {
    await _saveScheduledJobsToStorage(kept);
  }

  return kept;
}

async function _sendScheduleMessage(action, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "schedule_manager",
      action,
      payload
    });
    return response || { error: "No response from schedule manager" };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

/**
 * Schedule a tool call to execute at a future time via the background service worker.
 */
async function _execScheduleTool({ delaySeconds, timestamp, toolName, toolArgs, label, timeoutSeconds }, mcpRegistry) {
  return await _sendScheduleMessage("schedule", {
    delaySeconds,
    timestamp,
    toolName,
    toolArgs,
    label,
    timeoutSeconds,
    mcpRegistry: _snapshotScheduleMcpRegistry(mcpRegistry)
  });
}

/**
 * List scheduled tool calls directly from storage to avoid MV3 service worker
 * wake-up / response jitter in the schedule management UI.
 */
async function _execListScheduled() {
  const jobs = await _pruneExpiredScheduledJobsInStorage();
  if (jobs.length === 0) {
    return { scheduled: [], message: "No scheduled tasks" };
  }

  return {
    scheduled: jobs
      .slice()
      .sort((a, b) => b.fireTimestamp - a.fireTimestamp)
      .map(_serializeScheduledJob)
  };
}

/**
 * Cancel a pending scheduled tool call directly in storage.
 * The background service worker still owns creation and execution.
 */
async function _execCancelScheduled({ scheduleId }) {
  const jobs = await _pruneExpiredScheduledJobsInStorage();
  const index = jobs.findIndex(job => job.id === scheduleId);
  if (index < 0) {
    return { error: `Schedule not found: ${scheduleId}` };
  }

  const cancelled = jobs[index];
  if (cancelled.status !== "pending") {
    return { error: `Schedule ${scheduleId} is already ${cancelled.status}` };
  }

  cancelled.status = "cancelled";
  cancelled.finishedAt = Date.now();
  cancelled.error = null;
  cancelled.expiresAt = cancelled.finishedAt + SCHEDULE_RETENTION_MS;
  await _saveScheduledJobsToStorage(jobs);
  await _clearScheduledAlarms(cancelled.id);

  if (chrome.alarms && Number.isFinite(cancelled.expiresAt)) {
    await chrome.alarms.create(_buildScheduleCleanupAlarmName(cancelled.id), {
      when: Math.max(Date.now(), cancelled.expiresAt)
    });
  }

  return {
    success: true,
    cancelled: {
      scheduleId: cancelled.id,
      label: cancelled.label,
      toolName: cancelled.toolName,
      wasScheduledFor: new Date(cancelled.fireTimestamp).toLocaleString(),
      status: cancelled.status,
      expiresAt: new Date(cancelled.expiresAt).toLocaleString()
    }
  };
}

/**
 * Clear completed scheduled jobs directly in storage.
 */
async function _execClearCompletedScheduled() {
  const jobs = await _pruneExpiredScheduledJobsInStorage();
  const completedJobs = jobs.filter(job => _isTerminalScheduledStatus(job?.status));
  if (completedJobs.length === 0) {
    return { success: true, removedCount: 0, removedIds: [] };
  }

  const kept = jobs.filter(job => !_isTerminalScheduledStatus(job?.status));
  await _saveScheduledJobsToStorage(kept);

  for (const job of completedJobs) {
    await _clearScheduledAlarms(job.id);
  }

  return {
    success: true,
    removedCount: completedJobs.length,
    removedIds: completedJobs.map(job => job.id)
  };
}

const STASH_STORAGE_KEY = "user_stashes";
const DEFAULT_STASH_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

async function _getStashes() {
  const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
  return result[STASH_STORAGE_KEY] || {};
}

async function _saveStashes(stashes) {
  await chrome.storage.local.set({ [STASH_STORAGE_KEY]: stashes });
}

/**
 * Stash info to browser local storage with optional expiration.
 */
async function _execStashInBrowser({ title, info, expireAt }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };
  if (info === undefined || info === null) return { error: "info is required" };

  const stashes = await _getStashes();
  const now = Date.now();
  let computedExpireAt;
  if (expireAt === -1) {
    computedExpireAt = -1;
  } else if (typeof expireAt === "number" && expireAt > now) {
    computedExpireAt = expireAt;
  } else {
    computedExpireAt = now + DEFAULT_STASH_EXPIRE_MS;
  }

  stashes[title] = {
    info: String(info),
    expireAt: computedExpireAt,
    updatedAt: now
  };

  await _saveStashes(stashes);

  return {
    success: true,
    title,
    expireAt: computedExpireAt,
    permanent: computedExpireAt === -1
  };
}

/**
 * Get a single stash by title. Filters out expired stashes.
 */
async function _execUnstashInBrowser({ title }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };

  const stashes = await _getStashes();
  const stash = stashes[title];
  if (!stash) return { error: `Stash not found: ${title}` };

  const now = Date.now();
  if (stash.expireAt !== -1 && now > stash.expireAt) {
    delete stashes[title];
    await _saveStashes(stashes);
    return { error: `Stash has expired: ${title}` };
  }

  return {
    success: true,
    title,
    info: stash.info,
    expireAt: stash.expireAt,
    updatedAt: stash.updatedAt
  };
}

/**
 * List all stash titles, excluding expired ones.
 */
async function _execListStashesInBrowser() {
  const stashes = await _getStashes();
  const now = Date.now();
  const titles = [];
  let cleaned = false;

  for (const [title, stash] of Object.entries(stashes)) {
    if (stash.expireAt !== -1 && now > stash.expireAt) {
      delete stashes[title];
      cleaned = true;
    } else {
      titles.push(title);
    }
  }

  if (cleaned) await _saveStashes(stashes);

  return {
    success: true,
    count: titles.length,
    titles
  };
}

/**
 * Remove a stash by title.
 */
async function _execRemoveStashInBrowser({ title }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };

  const stashes = await _getStashes();
  if (!stashes[title]) {
    return { success: true, title, existed: false };
  }

  delete stashes[title];
  await _saveStashes(stashes);

  return { success: true, title, removed: true };
}

/**
 * Save content as a file and trigger a browser download via an anchor element.
 */
async function _execSaveToFile({ fileName, content }) {
  if (!fileName || typeof fileName !== "string") return { error: "fileName is required and must be a string" };
  if (content === undefined || content === null) return { error: "content is required" };

  try {
    const tab = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetTabId = tab?.[0]?.id;
    if (!targetTabId) return { error: "No active tab found to trigger download" };

    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      world: "MAIN",
      func: (fn, ct) => {
        const blob = new Blob([ct], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fn;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
      },
      args: [fileName, String(content)]
    });

    if (results?.[0]?.result === true) {
      return { success: true, fileName, size: new TextEncoder().encode(String(content)).length };
    }
    return { error: "Failed to trigger download on the page" };
  } catch (e) {
    return { error: e.message, hint: "Could not trigger file download" };
  }
}

// ==================== Streaming Chat ====================

/**
 * Send a streaming chat request to an LLM.
 * Supports both OpenAI-compatible and Anthropic Messages API.
 *
 * Tool calls are collected and included in the onDone callback so the caller
 * can execute them all and send results back in a single round-trip.
 *
 * @param {Object} config - { apiType, baseUrl, apiKey, model }
 * @param {Array} messages - conversation messages
 * @param {Object} callbacks - { onText, onDone, onError, onRetry }
 * @param {Array} [mcpTools] - MCP tools to include
 * @param {Object} [options]
 * @param {boolean} [options.includeBuiltins=true] - Whether to expose built-in browser tools
 * @returns {Function} abort
 */
export function streamChat(config, messages, { onText, onDone, onError, onRetry }, mcpTools = [], options = {}) {
  const controller = new AbortController();

  void _streamWithRetry(config, messages, controller.signal, { onText, onDone, onError, onRetry }, mcpTools, options);

  return () => controller.abort();
}

const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };

function buildOpenAICacheFields(options = {}) {
  const cacheKey = String(options?.sessionId || "").trim();
  return cacheKey ? { prompt_cache_key: cacheKey } : {};
}

// ==================== OpenAI Compatible ====================

async function _streamWithRetry(config, messages, signal, callbacks, mcpTools = [], options = {}) {
  const failures = [];

  for (let attempt = 1; attempt <= MAX_LLM_STREAM_RETRIES; attempt++) {
    if (signal.aborted) return;

    try {
      if (config.apiType === "anthropic") {
        await _streamAnthropicAttempt(config, messages, signal, callbacks, mcpTools, options);
      } else {
        await _streamOpenAIAttempt(config, messages, signal, callbacks, mcpTools, options);
      }
      return;
    } catch (error) {
      if (isAbortError(error) && signal.aborted) return;

      const normalizedError = normalizeLlmStreamError(error, {
        apiType: config.apiType,
        attempt,
        maxAttempts: MAX_LLM_STREAM_RETRIES
      });

      failures.push({
        attempt,
        code: normalizedError.code || "LLM_ERROR",
        message: normalizedError.message || "LLM request failed",
        status: normalizedError.status || null,
        detail: normalizedError.detail || null
      });

      if (attempt < MAX_LLM_STREAM_RETRIES) {
        callbacks.onRetry?.({
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: MAX_LLM_STREAM_RETRIES,
          error: normalizedError
        });
        try {
          await delayRetry(attempt, signal);
        } catch (retryError) {
          if (isAbortError(retryError)) return;
          throw retryError;
        }
        continue;
      }

      normalizedError.attempts = attempt;
      normalizedError.maxAttempts = MAX_LLM_STREAM_RETRIES;
      normalizedError.failures = failures;
      callbacks.onError?.(normalizedError);
      return;
    }
  }
}

async function _streamOpenAIAttempt(config, messages, signal, { onText, onDone }, mcpTools = [], options = {}) {
  const tools = getTools("openai", mcpTools, options);
  const url = resolveLlmRequestUrl("openai", config.baseUrl);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        stream: true,
        stream_options: { include_usage: true },
        ...buildOpenAICacheFields(options)
      }),
      signal: timeoutState.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw createLlmStreamError({
        code: `HTTP_${res.status}`,
        message: `LLM 接口返回 HTTP ${res.status}`,
        status: res.status,
        detail: errText || `HTTP ${res.status}`
      });
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw createLlmStreamError({
        code: "EMPTY_RESPONSE_BODY",
        message: "LLM 未返回响应流"
      });
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    const reasoningFields = {};
    const reasoningDetails = [];
    let toolCallsMap = {};
    let buffer = "";
    let sawToolCallDelta = false;
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        timeoutState.markFirstPacketReceived();
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          usage = mergeUsage(usage, extractOpenAIStreamUsage(json));
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            onText?.(delta.content);
          }

          const reasoningDeltas = extractOpenAIReasoningDeltas(delta);
          for (const [field, chunk] of Object.entries(reasoningDeltas)) {
            reasoningFields[field] = (reasoningFields[field] || "") + chunk;
          }
          if (Array.isArray(delta.reasoning_details)) {
            reasoningDetails.push(...delta.reasoning_details);
          }

          if (delta.tool_calls) {
            sawToolCallDelta = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: "", name: "", arguments: "" };
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
            }
          }
        } catch (error) {
          throw createLlmStreamError({
            code: "STREAM_PARSE_ERROR",
            message: "解析 OpenAI 流式响应失败",
            detail: error?.message || String(error)
          });
        }
      }
    }

    if (!timeoutState.firstPacketReceived) {
      throw buildFirstPacketTimeoutError(config);
    }

    const rawToolCalls = Object.entries(toolCallsMap)
      .filter(([, tc]) => tc.name)
      .map(([idx, tc]) => ({
        index: Number(idx),
        id: tc.id || `toolcall_${idx}_${Date.now()}`,
        name: tc.name,
        arguments: tc.arguments
      }));

    const parseFailures = [];
    const toolCalls = rawToolCalls
      .map(tc => {
        try {
          return {
            id: tc.id,
            name: tc.name,
            args: JSON.parse(tc.arguments || "{}"),
            _raw: tc.arguments || "{}"
          };
        } catch (error) {
          parseFailures.push({ name: tc.name, arguments: tc.arguments, error: error.message });
          return null;
        }
      })
      .filter(Boolean);

    if (parseFailures.length > 0) {
      throw createLlmStreamError({
        code: "TOOL_CALL_PARSE_ERROR",
        message: "工具调用参数解析失败",
        detail: parseFailures
      });
    }

    if (sawToolCallDelta && toolCalls.length === 0 && !fullContent) {
      throw createLlmStreamError({
        code: "EMPTY_TOOL_CALL_STREAM",
        message: "模型返回了工具调用片段，但未能重建有效工具调用"
      });
    }

    onDone?.({
      role: "assistant",
      content: fullContent || null,
      ...reasoningFields,
      ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
      ...(usage ? { usage } : {}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      _openaiToolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc._raw }
      })) : undefined
    });
  } catch (error) {
    if (timeoutState.didTimeout && !signal.aborted) {
      throw buildFirstPacketTimeoutError(config);
    }
    if (isAbortError(error) && signal.aborted) {
      throw error;
    }
    throw error;
  } finally {
    timeoutState.cleanup();
  }
}

function extractOpenAIReasoningDeltas(delta) {
  if (!delta || typeof delta !== "object") return {};

  const result = {};
  for (const field of ["reasoning_content", "reasoning", "thinking"]) {
    const value = extractReasoningText(delta[field]);
    if (value) result[field] = value;
  }
  return result;
}

function extractReasoningText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractReasoningText).join("");
  if (value && typeof value === "object") {
    return [
      value.reasoning_content,
      value.thinking,
      value.text,
      value.content
    ].map(extractReasoningText).join("");
  }
  return "";
}

function extractOpenAIStreamUsage(event) {
  if (!event || typeof event !== "object") return null;
  return firstUsageObject(
    event.usage,
    event.response?.usage,
    event.message?.usage,
    event.choices?.[0]?.usage,
    event.choices?.[0]?.delta?.usage
  );
}

function firstUsageObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

// ==================== Anthropic Messages API ====================

async function _streamAnthropicAttempt(config, messages, signal, { onText, onDone }, mcpTools = [], options = {}) {
  const tools = getTools("anthropic", mcpTools, options);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    let systemPrompt = "";
    const apiMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") systemPrompt = msg.content;
      else apiMessages.push(msg);
    }

    const url = resolveLlmRequestUrl("anthropic", config.baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: config.model,
        cache_control: DEFAULT_ANTHROPIC_CACHE_CONTROL,
        system: systemPrompt,
        messages: apiMessages,
        tools, max_tokens: 4096, stream: true
      }),
      signal: timeoutState.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw createLlmStreamError({
        code: `HTTP_${res.status}`,
        message: `LLM 接口返回 HTTP ${res.status}`,
        status: res.status,
        detail: errText || `HTTP ${res.status}`
      });
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw createLlmStreamError({
        code: "EMPTY_RESPONSE_BODY",
        message: "LLM 未返回响应流"
      });
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    let collectedToolUses = [];
    const activeContentBlocks = new Map();
    const rawContentBlocks = [];
    let buffer = "";
    let sawToolUseBlock = false;
    let usage = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        timeoutState.markFirstPacketReceived();
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);

        try {
          const json = JSON.parse(data);
          usage = mergeAnthropicUsage(usage, extractAnthropicStreamUsage(json));

          if (json.type === "content_block_start") {
            const index = getAnthropicEventIndex(json);
            const block = normalizeAnthropicContentBlockStart(json.content_block);
            if (block) {
              activeContentBlocks.set(index, block);
              if (block.type === "tool_use") sawToolUseBlock = true;
              if (block.type === "text" && block.text) {
                fullContent += block.text;
                onText?.(block.text);
              }
            }
          } else if (json.type === "content_block_delta") {
            const index = getAnthropicEventIndex(json);
            const block = activeContentBlocks.get(index);
            if (json.delta?.type === "text_delta") {
              const text = json.delta.text || "";
              fullContent += text;
              if (block?.type === "text") block.text += text;
              onText?.(text);
            } else if (json.delta?.type === "input_json_delta" && block?.type === "tool_use") {
              block.inputJson += json.delta.partial_json || "";
            } else if (json.delta?.type === "thinking_delta" && block?.type === "thinking") {
              block.thinking += json.delta.thinking || "";
            } else if (json.delta?.type === "signature_delta" && block?.type === "thinking") {
              block.signature = (block.signature || "") + (json.delta.signature || "");
            }
          } else if (json.type === "content_block_stop") {
            const index = getAnthropicEventIndex(json);
            const block = activeContentBlocks.get(index);
            if (block) {
              if (block.type === "tool_use") collectedToolUses.push(block);
              rawContentBlocks.push(block);
              activeContentBlocks.delete(index);
            }
          }
        } catch (error) {
          throw createLlmStreamError({
            code: "STREAM_PARSE_ERROR",
            message: "解析 Anthropic 流式响应失败",
            detail: error?.message || String(error)
          });
        }
      }
    }

    if (!timeoutState.firstPacketReceived) {
      throw buildFirstPacketTimeoutError(config);
    }

    const parseFailures = [];
    const parsedToolUsesByBlock = new Map();
    const toolCalls = collectedToolUses
      .map((tu, index) => {
        try {
          const id = tu.id || `tooluse_${index}_${Date.now()}`;
          const input = JSON.parse(tu.inputJson || "{}");
          parsedToolUsesByBlock.set(tu, { id, name: tu.name, input });
          return {
            id,
            name: tu.name,
            args: input
          };
        } catch (error) {
          parseFailures.push({ name: tu.name, inputJson: tu.inputJson, error: error.message });
          return null;
        }
      })
      .filter(Boolean);

    if (parseFailures.length > 0) {
      throw createLlmStreamError({
        code: "TOOL_CALL_PARSE_ERROR",
        message: "工具调用参数解析失败",
        detail: parseFailures
      });
    }

    if (sawToolUseBlock && toolCalls.length === 0 && !fullContent) {
      throw createLlmStreamError({
        code: "EMPTY_TOOL_CALL_STREAM",
        message: "模型返回了工具调用片段，但未能重建有效工具调用"
      });
    }

    const contentBlocks = rawContentBlocks
      .map(block => buildAnthropicContentBlock(block, parsedToolUsesByBlock))
      .filter(Boolean);
    if (fullContent && !contentBlocks.some(block => block.type === "text")) {
      contentBlocks.push({ type: "text", text: fullContent });
    }
    const thinkingBlocks = contentBlocks.filter(isAnthropicThinkingContentBlock);

    onDone?.({
      role: "assistant",
      content: contentBlocks.length > 0 ? contentBlocks : null,
      ...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });
  } catch (error) {
    if (timeoutState.didTimeout && !signal.aborted) {
      throw buildFirstPacketTimeoutError(config);
    }
    if (isAbortError(error) && signal.aborted) {
      throw error;
    }
    throw error;
  } finally {
    timeoutState.cleanup();
  }
}

function getAnthropicEventIndex(event) {
  return Number.isInteger(event?.index) ? event.index : 0;
}

function normalizeAnthropicContentBlockStart(contentBlock) {
  if (!contentBlock || typeof contentBlock !== "object") return null;

  if (contentBlock.type === "text") {
    return { type: "text", text: contentBlock.text || "" };
  }

  if (contentBlock.type === "tool_use") {
    return {
      type: "tool_use",
      id: contentBlock.id,
      name: contentBlock.name,
      inputJson: ""
    };
  }

  if (contentBlock.type === "thinking") {
    return {
      type: "thinking",
      thinking: contentBlock.thinking || "",
      ...(contentBlock.signature ? { signature: contentBlock.signature } : {})
    };
  }

  if (contentBlock.type === "redacted_thinking") {
    return {
      type: "redacted_thinking",
      data: contentBlock.data || ""
    };
  }

  return { ...contentBlock };
}

function buildAnthropicContentBlock(block, parsedToolUsesByBlock) {
  if (!block || typeof block !== "object") return null;

  if (block.type === "text") {
    return block.text ? { type: "text", text: block.text } : null;
  }

  if (block.type === "tool_use") {
    const parsed = parsedToolUsesByBlock.get(block);
    if (!parsed?.name) return null;
    return {
      type: "tool_use",
      id: parsed.id,
      name: parsed.name,
      input: parsed.input
    };
  }

  if (block.type === "thinking") {
    const thinking = block.thinking || "";
    const signature = block.signature || "";
    if (!thinking && !signature) return null;
    return {
      type: "thinking",
      thinking,
      ...(signature ? { signature } : {})
    };
  }

  if (block.type === "redacted_thinking") {
    return block.data ? { type: "redacted_thinking", data: block.data } : null;
  }

  return block;
}

function isAnthropicThinkingContentBlock(block) {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

function extractAnthropicStreamUsage(event) {
  if (!event || typeof event !== "object") return null;
  if (event.usage && typeof event.usage === "object") return event.usage;
  if (event.message?.usage && typeof event.message.usage === "object") return event.message.usage;
  return null;
}

function mergeAnthropicUsage(current = {}, next) {
  return mergeUsage(current, next);
}

function mergeUsage(current = {}, next) {
  if (!next || typeof next !== "object") return current || null;
  return { ...(current || {}), ...next };
}

function getFirstPacketTimeoutMs(config) {
  return Math.max(1, Number(config?.firstPacketTimeoutSeconds) || DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS) * 1000;
}

function createFirstPacketTimeoutState(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let firstPacketReceived = false;
  let didTimeout = false;

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    get firstPacketReceived() {
      return firstPacketReceived;
    },
    get didTimeout() {
      return didTimeout;
    },
    markFirstPacketReceived() {
      if (firstPacketReceived) return;
      firstPacketReceived = true;
      clearTimeout(timeoutId);
    },
    cleanup() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener?.("abort", abortFromParent);
    }
  };
}

function buildFirstPacketTimeoutError(config) {
  const timeoutSeconds = Math.max(1, Number(config?.firstPacketTimeoutSeconds) || DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS);
  return createLlmStreamError({
    code: "FIRST_PACKET_TIMEOUT",
    message: `首包超时，${timeoutSeconds} 秒内未收到响应`,
    detail: { timeoutSeconds }
  });
}

function createLlmStreamError({ code, message, status, detail }) {
  const error = new Error(message || "LLM request failed");
  error.code = code || "LLM_ERROR";
  if (status != null) error.status = status;
  if (detail != null) error.detail = detail;
  return error;
}

function normalizeLlmStreamError(error, { apiType, attempt, maxAttempts }) {
  if (error?.code) {
    error.apiType = apiType;
    error.attempt = attempt;
    error.maxAttempts = maxAttempts;
    return error;
  }

  const normalized = createLlmStreamError({
    code: inferLlmErrorCode(error),
    message: error?.message || "LLM 请求失败",
    detail: error?.stack || String(error)
  });
  normalized.apiType = apiType;
  normalized.attempt = attempt;
  normalized.maxAttempts = maxAttempts;
  return normalized;
}

function inferLlmErrorCode(error) {
  if (isAbortError(error)) return "REQUEST_ABORTED";
  if (error instanceof TypeError) return "NETWORK_ERROR";
  return "LLM_ERROR";
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function delayRetry(attempt, signal) {
  const delayMs = Math.min(800, attempt * 250);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
