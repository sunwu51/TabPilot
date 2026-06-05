import { DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS } from "../core/constants";
import { API_TYPES, normalizeApiType } from "../core/config";

const DOM_LOCATOR_PROPERTIES = {
  tabId: { type: "number", description: "Optional browser tab ID. Defaults to the current active tab." },
  selector: { type: "string", description: "Optional CSS selector used to find elements." },
  text: { type: "string", description: "Optional text to match against element text or labels." },
  matchExact: { type: "boolean", description: "Whether text matching should be exact. Defaults to false." },
  index: { type: "number", description: "Zero-based index within the matched elements. Defaults to 0." }
};
const BETA_TOOL_NAMES = new Set(["list_macros", "describe_macro", "run_macro"]);
const IMAGE_TOOL_NAMES = new Set(["image_gen", "image_edit"]);

export function isImageToolName(toolName) {
  return IMAGE_TOOL_NAMES.has(String(toolName || "").trim());
}

// ==================== Tool Definitions ====================

export const TOOLS = [

  {
    name: "plan_create_for_session",
    description: "Create or replace the latest high-level execution plan for the current agent session. Use this before starting a complex multi-step task. The plan must be user-readable and should describe meaningful task steps, not low-level tool calls. The application will ask the user to approve or revise the plan before you continue.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short user-facing title of the plan." },
        steps: {
          type: "array",
          description: "High-level task steps in execution order. Keep steps concise, concrete, and outcome-oriented.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short title of this step." },
              description: { type: "string", description: "Optional detail explaining what this step will accomplish." }
            },
            required: ["title"]
          }
        }
      },
      required: ["title", "steps"]
    }
  },
  {
    name: "plan_update_for_session",
    description: "Update the latest high-level execution plan for the current agent session while carrying out an approved complex task. Use this when a step starts, completes, is skipped, or becomes blocked.",
    schema: {
      type: "object",
      properties: {
        stepIndex: { type: "number", description: "Zero-based index of the step to update." },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "blocked", "skipped"],
          description: "New status for the selected step."
        },
        note: { type: "string", description: "Optional short progress note, finding, or blocker for this step." }
      },
      required: ["stepIndex", "status"]
    }
  },
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
        toolName: { type: "string", description: "Name of the tool to call (e.g. tab_open, tab_close, mcp_server_tool)" },
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
        expireAt: { type: "number", description: "Expiration timestamp in Unix milliseconds. Use -1 for permanent storage. Defaults to permanent storage if omitted; only set a finite future timestamp when the information should intentionally expire, such as one month from now." }
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
    name: "list_macros",
    description: "List saved browser macros that can be replayed. Use this before run_macro unless the user provided an exact macro id. Returns macro ids, names, start URLs, step counts, and input variables including input_1/input_2 keys for overriding recorded inputs.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search text matched against macro name." }
      },
      required: []
    }
  },
  {
    name: "describe_macro",
    description: "Get details about a saved browser macro, including start URL, step summary, and input variables. Use this before run_macro when you need to know which inputValues keys to provide or override.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved macro id." }
      },
      required: ["id"]
    }
  },
  {
    name: "run_macro",
    description: "Run a saved browser macro by opening its startUrl in a new tab and replaying its steps. Provide top-level arguments: id, inputValues, speed, and stepDelayMs. Use inputValues to override recorded input/change values, including text inputs, password inputs, selects, checkboxes, and radio steps. Call describe_macro first if you do not know the input keys.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The saved macro id to run. Get this from list_macros or describe_macro." },
        inputValues: {
          type: "object",
          description: "Optional values keyed by macro input key such as input_1, input_2, or a step valueRef. Only include keys you want to override; missing keys keep the macro's recorded/default values. Radio/checkbox values should be true/false strings or booleans."
        },
        speed: {
          type: "string",
          enum: ["slow", "normal", "fast", "instant"],
          description: "Replay speed preset. Defaults to normal. If stepDelayMs is provided, it overrides the preset delay."
        },
        stepDelayMs: {
          type: "number",
          description: "Optional custom delay between operations in milliseconds. When provided, it overrides the selected speed preset."
        }
      },
      required: ["id"]
    }
  },
  {
    name: "download",
    description: "Trigger a browser download and save it to the user's Downloads folder. Provide EITHER `url` (an http(s):// link or a base64 data: URL) OR `content` (a plain text string to write into the file), together with `fileName`. When `url` is given, the browser performs the download with the user's existing cookies/session, which works for pages that require authentication. Use `content` for generating reports, notes, or other text artifacts on the fly. The optional `mimeType` only affects `content` text downloads; it does not change the MIME type of `url` downloads.",
    schema: {
      type: "object",
      properties: {
        fileName: { type: "string", description: "The name of the file to save, including extension (e.g. 'report.md', 'data.json', 'image.png')." },
        url: { type: "string", description: "Optional source URL. Supports http(s):// links (cookies are sent) and base64 data: URLs (e.g. 'data:image/png;base64,...'). Mutually exclusive with `content`." },
        content: { type: "string", description: "Optional plain text content to save into the file. Mutually exclusive with `url`." },
        mimeType: { type: "string", description: "Optional MIME type for `content` text downloads, such as 'text/markdown;charset=utf-8', 'application/json;charset=utf-8', 'text/csv;charset=utf-8', or 'text/html;charset=utf-8'. Ignored for `url` downloads; for http(s) URLs the server/browser determines MIME, and for data: URLs the MIME is already embedded in the URL." }
      },
      required: ["fileName"]
    }
  },
  {
    name: "download_list",
    description: "List the most recent browser downloads (newest first). Each entry includes the absolute local file path under `filename`, plus state/size/mime info. Use this when the user asks 'what did I download recently' or to find a file path you previously saved with the `download` tool.",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of records to return (default 20, max 100)." }
      },
      required: []
    }
  },
  {
    name: "download_search",
    description: "Search browser download history with filters. Each result includes `filename` (absolute local path), `url`, `state`, `mime`, `totalBytes`, `startTime`/`endTime`, etc. Use this when the user asks for a specific past download, or to find a file path by URL or name fragment.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text terms (space-separated). All terms must appear in the URL or filename. Case-insensitive substring match." },
        filenameRegex: { type: "string", description: "Optional regular expression matched against the absolute file path." },
        urlRegex: { type: "string", description: "Optional regular expression matched against the source URL." },
        state: { type: "string", enum: ["in_progress", "interrupted", "complete"], description: "Filter by download state." },
        startedAfter: { type: "number", description: "Only return downloads started at or after this Unix timestamp in milliseconds." },
        startedBefore: { type: "number", description: "Only return downloads started at or before this Unix timestamp in milliseconds." },
        limit: { type: "number", description: "Maximum number of records to return (default 50, max 100)." }
      },
      required: []
    }
  },
  {
    name: "html_playground",
    description: "Generate and open a standalone HTML playground page for previewing HTML/CSS/JS. Use this when the user asks to open, preview, display, share, or generate a playground/page/demo/report, including simple pages that do not explicitly mention HTML. This is also suitable for generating visual reports; when drawing charts, you can import Chart.js from a CDN in the HTML and render line charts, bar charts, pie charts, and other data visualizations. If the chart is simple enough, native inline SVG is also acceptable. Do not use this tool to render very large text-only content.",
    schema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML body/source to render. It may directly include inline CSS in <style> tags and JavaScript in <script> tags if desired." },
        css: { type: "string", description: "Additional CSS injected into a <style> tag in the generated preview document." },
        js: { type: "string", description: "Additional JavaScript injected into a <script> tag in the generated preview document." },
        expanded: { type: "boolean", description: "Whether the HTML/CSS/JS editor inputs should be expanded initially. Defaults to false, meaning the inputs start collapsed and the iframe preview fills the page." }
      },
      required: []
    }
  },
  {
    name: "image_gen",
    description: "Generate an image through the configured OpenAI-compatible Images API generations endpoint. Use this when the user asks to create a new image. The tool returns an image result that the host stores as a local ref; after the tool result tells you the ref, show it with Markdown like ![image](|deRef:img_1|) instead of copying base64.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Required image generation prompt." },
        image_model_id: { type: "string", description: "Optional configured Image model id. If omitted, the current Image model from settings is used." },
        size: { type: "string", description: "Optional output size, such as auto, 1024x1024, 1024x1536, or 1536x1024." },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: "Optional rendering quality. Defaults to the provider/model default." },
        background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Optional background mode when supported by the model." },
        output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "Optional output format. Defaults to png for local preview if the API returns base64 without a MIME type." },
        output_compression: { type: "number", description: "Optional compression level from 0 to 100 for jpeg/webp outputs when supported." },
        n: { type: "number", description: "Optional number of images to request. The UI previews the first returned image." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "image_edit",
    description: "Edit one or more input images through the configured OpenAI-compatible Images API edits endpoint. Use this when the user asks to modify an attached/generated image. Prefer `images` as an ordered array: the first image is the image to edit, and later images are references. If you have an image ref such as img_1, pass exactly \"|deRef:img_1|\" and the host will replace it before execution. Optional `mask` applies only to the first image and should be a PNG mask ref/data URL. The tool returns an image result stored as a local ref; show it with Markdown like ![image](|deRef:img_2|) after the tool result tells you the ref.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Required edit instruction." },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Ordered input images. The first item is edited; later items are reference images. Use exact placeholders like |deRef:img_1| for cached images."
        },
        image: { type: "string", description: "Legacy first/source image. Use exact placeholders like |deRef:img_1| for cached images when not using `images`." },
        additional_images: {
          type: "array",
          items: { type: "string" },
          description: "Legacy additional reference images used with `image`. Use exact placeholders like |deRef:img_2| when available."
        },
        mask: { type: "string", description: "Optional mask image for the first input image only. Use exact placeholders like |deRef:img_3| when available. For OpenAI Images API masks, the first image and mask should have the same dimensions and the mask should include alpha." },
        image_model_id: { type: "string", description: "Optional configured Image model id. If omitted, the current Image model from settings is used." },
        size: { type: "string", description: "Optional output size, such as auto, 1024x1024, 1024x1536, or 1536x1024." },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: "Optional rendering quality. Defaults to the provider/model default." },
        background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Optional background mode when supported by the model." },
        output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "Optional output format. Defaults to png for local preview if the API returns base64 without a MIME type." },
        output_compression: { type: "number", description: "Optional compression level from 0 to 100 for jpeg/webp outputs when supported." },
        n: { type: "number", description: "Optional number of images to request. The UI previews the first returned image." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "sleep",
    description: "Pause the agent for a fixed number of seconds. Use this when you must wait for a page transition, an external job, or a tool result that is not yet available, instead of polling repeatedly. Prefer sleep over tight retry loops. Range: 1 to 300 seconds (max 5 minutes per call). This tool has no built-in timeout.",
    schema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: "How long to sleep, in seconds. Must be an integer between 1 and 300 (inclusive)."
        }
      },
      required: ["seconds"]
    }
  }
];

export const BUILTIN_TOOL_COUNT = TOOLS.length;
export const BUILTIN_TOOL_NAMES = TOOLS.map(t => t.name);

export function buildMcpToolCallName(serverName, toolName) {
  return `mcp_${serverName}_${toolName}`;
}

export function isMcpToolCallName(toolName) {
  return typeof toolName === "string" && toolName.startsWith("mcp_") && !toolName.startsWith("mcp__");
}

function buildMcpToolNameVariants(toolName) {
  const normalizedName = String(toolName || "").trim();
  const variants = new Set();
  if (!normalizedName) return [];
  variants.add(normalizedName);
  const underscoreVariant = normalizedName.replace(/-/g, "_");
  if (underscoreVariant) {
    variants.add(underscoreVariant);
  }
  return [...variants];
}

export function getMcpToolCallAliases(tool = {}) {
  const aliases = new Set();
  const explicitToolCallName = String(tool?._toolCallName || "").trim();
  const serverName = String(tool?._serverName || "server").trim();
  const toolName = String(tool?.name || "").trim();

  if (explicitToolCallName) {
    aliases.add(explicitToolCallName);
    aliases.add(explicitToolCallName.replace(/-/g, "_"));
  }
  if (serverName && toolName) {
    for (const toolNameVariant of buildMcpToolNameVariants(toolName)) {
      aliases.add(buildMcpToolCallName(serverName, toolNameVariant));
    }
  }

  return [...aliases];
}

export function findMcpToolByCallName(mcpRegistry = [], requestedName) {
  const normalizedRequestedName = String(requestedName || "").trim();
  if (!normalizedRequestedName) return null;

  let rawNameMatch = null;
  let rawNameAmbiguous = false;

  for (const tool of mcpRegistry || []) {
    if (!tool) continue;

    if (String(tool.name || "").trim() === normalizedRequestedName) {
      if (rawNameMatch) {
        rawNameAmbiguous = true;
      } else {
        rawNameMatch = tool;
      }
    }

    if (getMcpToolCallAliases(tool).includes(normalizedRequestedName)) {
      return tool;
    }
  }

  if (!rawNameAmbiguous) {
    return rawNameMatch;
  }
  return null;
}

/**
 * Get tool definitions formatted for the specified API type.
 * Merges built-in tools with MCP tools.
 * @param {string} apiType - OpenAI Chat Completions, OpenAI Responses, or Anthropic API type.
 * @param {Array} [mcpTools] - MCP tools from connected servers [{name, description, inputSchema, _serverUrl, _serverHeaders, _toolCallName}]
 * @param {Object} [options]
 * @param {boolean} [options.includeBuiltins=true] - Whether to include built-in browser tools
 * @param {boolean} [options.supportsImageInput=false] - Whether the selected model accepts image inputs
 * @param {boolean} [options.enableBetaFeatures=true] - Whether to include beta built-in tools.
 * @param {boolean} [options.imageToolsEnabled=false] - Whether configured Image API tools should be exposed.
 * @returns {Array} formatted tool definitions
 */
export function getTools(apiType, mcpTools = [], { includeBuiltins = true, supportsImageInput = false, enableBetaFeatures = true, imageToolsEnabled = false } = {}) {
  // Convert MCP tools to our internal format
  const externalTools = mcpTools.map(t => ({
    name: t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name),
    description: `[MCP] ${t.description || t.name}`,
    schema: t.inputSchema || { type: "object", properties: {} }
  }));

  const builtInTools = includeBuiltins
    ? TOOLS.filter(tool => {
      if (!supportsImageInput && tool.name === "tab_screenshot") return false;
      if (enableBetaFeatures === false && BETA_TOOL_NAMES.has(tool.name)) return false;
      if (imageToolsEnabled !== true && isImageToolName(tool.name)) return false;
      return true;
    })
    : [];
  const allTools = [...builtInTools, ...externalTools];

  const normalizedApiType = normalizeApiType(apiType);

  if (normalizedApiType === API_TYPES.ANTHROPIC) {
    return allTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema
    }));
  }
  if (normalizedApiType === API_TYPES.OPENAI_RESPONSES) {
    return allTools.map(t => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.schema,
      strict: false
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
