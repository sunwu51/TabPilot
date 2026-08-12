/* global chrome */
import { callMcpTool } from "../../mcp";
import { isMcpToolCallName, findMcpToolByCallName } from "./definitions";
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS,
  DEFAULT_MCP_TOOL_TIMEOUT_SECONDS,
  RUN_MACRO_TOOL_TIMEOUT_SECONDS
} from "../core/constants";
import { executeImageEdit, executeImageGeneration } from "./builtins/imageApi";

import { withTimeout } from "./builtins/_shared";
import {
  _execTabList,
  _execTabExtract,
  _execTabScroll,
  _execTabOpen,
  _execTabFocus,
  _execTabClose,
  _execTabGroup,
  _execTabGetActive,
  _execTabScreenshot,
  captureFullPageScreenshotToTab
} from "./builtins/tabs";
import {
  _execDomQuery,
  _execDomClick,
  _execDomSetValue,
  _execDomStyle,
  _execDomGetHtml,
  _execDomHighlight
} from "./builtins/dom";
import { _execEvalJs, _execHtmlPlayground, openHelloWorldPlayground } from "./builtins/evalAndPlayground";
import {
  _execGroupList,
  _execGroupGet,
  _execGroupUpdate,
  _execGroupAddTabs,
  _execGroupRemoveTabs,
  _execGroupUngroup
} from "./builtins/groups";
import {
  _execWindowList,
  _execWindowGetCurrent,
  _execWindowFocus,
  _execWindowMoveTab,
  _execWindowCreate,
  _execWindowClose
} from "./builtins/windows";
import { _execHistorySearch, _execHistoryRecent } from "./builtins/history";
import { _execListMacros, _execDescribeMacro, _execRunMacro } from "./builtins/macros";
import {
  _execScheduleTool,
  _execListScheduled,
  _execCancelScheduled,
  _execClearCompletedScheduled
} from "./builtins/schedule";
import {
  _execStashInBrowser,
  _execUnstashInBrowser,
  _execListStashesInBrowser,
  _execRemoveStashInBrowser
} from "./builtins/stash";
import { _execDownload, _execDownloadList, _execDownloadSearch } from "./builtins/downloads";
import { _execGetCurrentTime, _execSleep } from "./builtins/misc";
import { _execPageAgent, initializePageAgent } from "./builtins/pageAgent";
import {
  _execPostdogGetHistoryRun,
  _execPostdogGetRequest,
  _execPostdogListEnvironments,
  _execPostdogListFolders,
  _execPostdogListHistory,
  _execPostdogListRequests,
  _execPostdogRunRequest,
  _execPostdogSaveEnvironment,
  _execPostdogSaveFolder,
  _execPostdogSaveRequest,
  _execPostdogSetActiveEnvironment
} from "./builtins/postdog";

export { captureFullPageScreenshotToTab, openHelloWorldPlayground };

/**
 * Execute a tool call by name. Routes to the appropriate handler.
 * MCP tool names use the configured server name namespace and are routed
 * to the corresponding MCP server.
 * All executors return a result object (never throw).
 * @param {string} name - tool name
 * @param {Object} args - tool arguments
 * @param {Array} [mcpRegistry] - MCP tool registry [{name, _serverUrl, _serverHeaders, _serverType, _serverExtensionId, _toolCallName}]
 * @returns {Promise<Object>} result to send back to LLM
 */
export async function executeTool(name, args, mcpRegistry = []) {
  try {
    if (isMcpToolCallName(name)) {
      const mcpTool = findMcpToolByCallName(mcpRegistry, name);
      if (!mcpTool) return { error: `MCP tool not found: ${name}` };
      const { mcpToolTimeoutSeconds } = await chrome.storage.local.get({
        mcpToolTimeoutSeconds: DEFAULT_MCP_TOOL_TIMEOUT_SECONDS
      });
      const timeoutMs = Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_MCP_TOOL_TIMEOUT_SECONDS) * 1000;
      const endpoint = mcpTool._serverType === "extension"
        ? { type: "extension", extensionId: mcpTool._serverExtensionId, name: mcpTool._serverName }
        : { type: "http", url: mcpTool._serverUrl, headers: mcpTool._serverHeaders };
      return await callMcpTool(endpoint, mcpTool._serverHeaders, mcpTool.name, args, timeoutMs);
    }

    const handler = BUILTIN_TOOL_HANDLERS[name];
    const runBuiltinTool = handler
      ? () => handler(args, mcpRegistry)
      : () => ({ error: `Unknown tool: ${name}` });

    // Waiting intentionally has no timeout — its whole purpose is to pause.
    // Input validation in _execSleep already caps the duration at 300s.
    if (name === "sleep" || name === "wait") {
      return await runBuiltinTool();
    }

    return await withTimeout(
      runBuiltinTool(),
      getBuiltinToolTimeoutSeconds(name) * 1000,
      `Built-in tool timed out after ${getBuiltinToolTimeoutSeconds(name)}s: ${name}`
    );
  } catch (e) {
    return {
      error: e.message,
      hint: "The operation failed."
    };
  }
}

export function getBuiltinToolTimeoutSeconds(name) {
  if (name === "run_macro") return RUN_MACRO_TOOL_TIMEOUT_SECONDS;
  if (name === "page_agent_execute" || name === "image_gen" || name === "image_edit") return 900;
  return DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS;
}

export { initializePageAgent };

const BUILTIN_TOOL_HANDLERS = {
  tab_list: (args) => _execTabList(args),
  tab_extract: (args) => _execTabExtract(args),
  tab_scroll: (args) => _execTabScroll(args),
  tab_open: (args) => _execTabOpen(args),
  tab_focus: (args) => _execTabFocus(args),
  tab_close: (args) => _execTabClose(args),
  tab_group: (args) => _execTabGroup(args),
  tab_get_active: () => _execTabGetActive(),
  tab_screenshot: (args) => _execTabScreenshot(args),
  page_agent_execute: (args) => _execPageAgent(args),

  dom_query: (args) => _execDomQuery(args),
  dom_click: (args) => _execDomClick(args),
  dom_set_value: (args) => _execDomSetValue(args),
  dom_style: (args) => _execDomStyle(args),
  dom_get_html: (args) => _execDomGetHtml(args),
  dom_highlight: (args) => _execDomHighlight(args),

  eval_js: (args) => _execEvalJs(args),
  html_playground: (args) => _execHtmlPlayground(args),

  group_list: () => _execGroupList(),
  group_get: (args) => _execGroupGet(args),
  group_update: (args) => _execGroupUpdate(args),
  group_add_tabs: (args) => _execGroupAddTabs(args),
  group_remove_tabs: (args) => _execGroupRemoveTabs(args),
  group_ungroup: (args) => _execGroupUngroup(args),

  window_list: () => _execWindowList(),
  window_get_current: () => _execWindowGetCurrent(),
  window_focus: (args) => _execWindowFocus(args),
  window_move_tab: (args) => _execWindowMoveTab(args),
  window_create: (args) => _execWindowCreate(args),
  window_close: (args) => _execWindowClose(args),

  history_search: (args) => _execHistorySearch(args),
  history_recent: (args) => _execHistoryRecent(args),

  list_macros: (args) => _execListMacros(args),
  describe_macro: (args) => _execDescribeMacro(args),
  run_macro: (args) => _execRunMacro(args),

  schedule_tool: (args, mcpRegistry) => _execScheduleTool(args, mcpRegistry),
  list_scheduled: () => _execListScheduled(),
  cancel_scheduled: (args) => _execCancelScheduled(args),
  clear_completed_scheduled: () => _execClearCompletedScheduled(),

  stash_in_browser: (args) => _execStashInBrowser(args),
  unstash_in_browser: (args) => _execUnstashInBrowser(args),
  list_stashes_in_browser: () => _execListStashesInBrowser(),
  remove_stash_in_browser: (args) => _execRemoveStashInBrowser(args),

  download: (args) => _execDownload(args),
  download_list: (args) => _execDownloadList(args),
  download_search: (args) => _execDownloadSearch(args),

  postdog_list_folders: () => _execPostdogListFolders(),
  postdog_save_folder: (args) => _execPostdogSaveFolder(args),
  postdog_list_requests: (args) => _execPostdogListRequests(args),
  postdog_get_request: (args) => _execPostdogGetRequest(args),
  postdog_save_request: (args) => _execPostdogSaveRequest(args),
  postdog_run_request: (args) => _execPostdogRunRequest(args),
  postdog_list_history: (args) => _execPostdogListHistory(args),
  postdog_get_history_run: (args) => _execPostdogGetHistoryRun(args),
  postdog_list_environments: () => _execPostdogListEnvironments(),
  postdog_save_environment: (args) => _execPostdogSaveEnvironment(args),
  postdog_set_active_environment: (args) => _execPostdogSetActiveEnvironment(args),

  image_gen: (args) => executeImageGeneration(args),
  image_edit: (args) => executeImageEdit(args),

  get_current_time: () => _execGetCurrentTime(),
  sleep: (args) => _execSleep(args),
  wait: (args) => _execSleep(args)
};
