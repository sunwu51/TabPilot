/* global chrome */
import { callMcpTool } from "../mcp";
import { buildMcpToolCallName } from "./tools";
import { triggerBrowserDownload } from "./downloadHelper";
import { DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS, DEFAULT_MCP_TOOL_TIMEOUT_SECONDS, DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS, DEFAULT_STASH_EXPIRE_MS, RUN_MACRO_TOOL_TIMEOUT_SECONDS, SCHEDULE_CLEANUP_ALARM_PREFIX, SCHEDULE_FIRE_ALARM_PREFIX, SCHEDULE_RETENTION_MS, SCHEDULE_STORAGE_KEY, STASH_STORAGE_KEY, TERMINAL_SCHEDULE_STATUSES } from "./constants";


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
        case "list_macros": return _execListMacros(args);
        case "describe_macro": return _execDescribeMacro(args);
        case "run_macro": return _execRunMacro(args);
        case "download": return _execDownload(args);
        case "download_list": return _execDownloadList(args);
        case "download_search": return _execDownloadSearch(args);
        case "sleep": return _execSleep(args);
        default: return { error: `Unknown tool: ${name}` };
      }
    };

    // `sleep` intentionally has no timeout — its whole purpose is to wait.
    // Input validation in _execSleep already caps the duration at 300s.
    if (name === "sleep") {
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

function getBuiltinToolTimeoutSeconds(name) {
  if (name === "run_macro") return RUN_MACRO_TOOL_TIMEOUT_SECONDS;
  return DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS;
}

function _sendMacroManagerMessage(action, payload = {}) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "macro_manager", action, payload }, response => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: "Empty macro manager response" });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || String(error) });
    }
  });
}

async function _execListMacros({ query } = {}) {
  const res = await _sendMacroManagerMessage("list_for_ai", { query });
  if (!res?.success) return { error: res?.error || "Failed to list macros" };
  return { macros: res.data || [] };
}

async function _execDescribeMacro({ id } = {}) {
  if (!id || typeof id !== "string") return { error: "id is required" };
  const res = await _sendMacroManagerMessage("describe_for_ai", { id });
  if (!res?.success) return { error: res?.error || "Failed to describe macro" };
  if (!res.data) return { error: `Macro not found: ${id}` };
  return { macro: res.data };
}

async function _execRunMacro({ id, inputValues = {}, speed = "normal", stepDelayMs } = {}) {
  if (!id || typeof id !== "string") return { error: "id is required" };
  const options = { speed };
  if (stepDelayMs != null) options.stepDelayMs = Number(stepDelayMs);
  const res = await _sendMacroManagerMessage("replay", { id, inputValues, options });
  if (!res?.success) return { error: res?.error || "Failed to run macro" };
  return {
    tabId: res.tabId,
    report: res.report
  };
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
 * Normalize Chrome's splitViewId field (Chrome 140+) for tool responses.
 * Returns null when the tab is not part of any split view (or on older Chrome
 * builds that don't expose the field at all).
 */
function _normalizeSplitViewId(splitViewId) {
  if (typeof splitViewId !== "number") return null;
  const noneId = chrome?.tabs?.SPLIT_VIEW_ID_NONE;
  if (typeof noneId === "number" && splitViewId === noneId) return null;
  if (splitViewId < 0) return null;
  return splitViewId;
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
    splitViewId: _normalizeSplitViewId(tab.splitViewId),
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
      splitViewId: _normalizeSplitViewId(tab.splitViewId),
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
      splitViewId: _normalizeSplitViewId(resolved.tab.splitViewId),
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
 *
 * Why this is structured the way it is:
 *
 * The runner CANNOT use `new Function(userCode)` on the extension side —
 * MV3 extension CSP is `script-src 'self'` and forbids `unsafe-eval`, and
 * MV3 does not allow extensions to opt out. So the user code must be passed
 * as a STRING ARGUMENT to a statically-defined runner function, which is
 * serialized by chrome.scripting and re-parsed in the page main world.
 *
 * Inside the page, two strategies are tried in order:
 *   1. `new Function(source)` — needs page CSP `script-src 'unsafe-eval'`
 *   2. `<script>` element with inline source — needs page CSP
 *      `script-src-elem 'unsafe-inline'`
 *
 * Most pages allow at least one. Pages that block both (e.g. CSP-3 strict
 * with no nonce) get a clear error rather than a silent timeout.
 */
async function _execEvalJs({ jsScript }) {
  const resolved = await _resolveControllableTab(undefined, "run code on");
  if (resolved.error) return { error: resolved.error };

  const world = "MAIN";
  try {
    // Inner timeout (8s) is intentionally tighter than the outer
    // DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS (10s) so an informative inner
    // error surfaces before the generic outer timeout fires.
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: resolved.tab.id },
        world,
        func: __evalJsPageRunner,
        args: [jsScript]
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(
          "eval_js timed out after 8s — the script may be in an infinite loop, awaiting a promise that never resolves, or otherwise hung."
        )), 8000);
      })
    ]);

    const data = results?.[0]?.result;
    if (!data) return { error: "No result returned from JavaScript execution" };

    return {
      world,
      tabId: resolved.tab.id,
      windowId: resolved.tab.windowId,
      groupId: _normalizeGroupId(resolved.tab.groupId),
      splitViewId: _normalizeSplitViewId(resolved.tab.splitViewId),
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
 * Self-contained runner injected into the target page main world by
 * chrome.scripting.executeScript. Receives the user's source as a string,
 * tries Function-constructor execution first, falls back to <script> tag
 * injection, and returns the result (or a CSP-aware error).
 *
 * Must not close over any extension-side variables — chrome.scripting
 * serializes via toString() and re-parses in the page context.
 */
async function __evalJsPageRunner(source) {
  function normalizeResult(value) {
    if (value === undefined) return { kind: "undefined", value: null };
    if (value === null) return null;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return { kind: typeof value, value: String(value) };
      return JSON.parse(json);
    } catch (e) {
      return { kind: typeof value, value: String(value) };
    }
  }

  function isCspEvalError(message) {
    return /unsafe-eval|Refused to evaluate|EvalError/i.test(String(message || ""));
  }

  // ---- Strategy 1: Function constructor (page CSP: needs unsafe-eval) ----
  let cspEvalBlocked = false;
  try {
    const wrapped = "return (async () => {\n" + source + "\n})();";
    // eslint-disable-next-line no-new-func
    const fn = new Function(wrapped);
    const result = await fn();
    return {
      success: true,
      strategy: "function",
      url: document.URL,
      title: document.title,
      result: normalizeResult(result)
    };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (!isCspEvalError(message)) {
      // Real syntax/runtime error from user code — return immediately,
      // don't waste a fallback round-trip on it.
      return {
        error: message,
        stack: e && e.stack ? String(e.stack).slice(0, 4000) : null,
        strategy: "function",
        url: document.URL,
        title: document.title
      };
    }
    cspEvalBlocked = true;
  }

  // ---- Strategy 2: <script> tag (page CSP: needs unsafe-inline) ----
  const channel = "__tab_manager_eval_js_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  const scriptResult = await new Promise((resolve) => {
    let settled = false;
    function finish(payload) {
      if (settled) return;
      settled = true;
      window.removeEventListener(channel, onResult);
      resolve(payload);
    }
    function onResult(event) {
      finish(event && event.detail ? event.detail : { error: "No result returned from injected script" });
    }
    window.addEventListener(channel, onResult, { once: true });

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.textContent =
      "(async () => {\n" +
      "  try {\n" +
      "    const __result = await (async () => {\n" +
      source + "\n" +
      "    })();\n" +
      "    window.dispatchEvent(new CustomEvent(" + JSON.stringify(channel) + ", { detail: { success: true, result: __result } }));\n" +
      "  } catch (e) {\n" +
      "    window.dispatchEvent(new CustomEvent(" + JSON.stringify(channel) + ", { detail: { error: (e && e.message) ? e.message : String(e), stack: (e && e.stack) ? String(e.stack).slice(0, 4000) : null } }));\n" +
      "  }\n" +
      "})();";

    const parent = document.documentElement || document.head || document.body;
    if (!parent) {
      finish({ error: "Unable to inject script into this page" });
      return;
    }
    parent.appendChild(script);
    script.remove();

    // Wait a tick: if CSP blocked the inline script, the dispatchEvent will
    // never fire. 6s gives a slow real script room to finish but stays well
    // under the outer 8s race.
    setTimeout(() => {
      finish({ error: "csp_inline_blocked" });
    }, 6000);
  });

  if (scriptResult && scriptResult.success) {
    return {
      success: true,
      strategy: "script-tag",
      url: document.URL,
      title: document.title,
      result: normalizeResult(scriptResult.result)
    };
  }

  // Real runtime error from the script-tag path
  if (scriptResult && scriptResult.error && scriptResult.error !== "csp_inline_blocked") {
    return {
      error: scriptResult.error,
      stack: scriptResult.stack || null,
      strategy: "script-tag",
      url: document.URL,
      title: document.title
    };
  }

  // Both strategies blocked by page CSP.
  return {
    error: "Page CSP blocks both Function-constructor (script-src 'unsafe-eval') and inline <script> elements (script-src-elem 'unsafe-inline'). Cannot execute arbitrary JavaScript on this page.",
    strategy: "both-blocked",
    cspEvalBlocked,
    cspInlineBlocked: true,
    url: document.URL,
    title: document.title,
    hint: "Try a less restrictive page, or use the structured DOM tools (dom_query, dom_click, dom_set_value) which do not require dynamic code execution."
  };
}

/**
 * Open a new tab with the given URL. Optionally focus on it.
 */
async function _execTabOpen({ url, active }) {
  if (!/^(https?:\/\/|data:|file:\/\/)/i.test(url)) url = "https://" + url;
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
    splitViewId: _normalizeSplitViewId(tab.splitViewId),
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
    splitViewId: _normalizeSplitViewId(tab.splitViewId),
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
    splitViewId: _normalizeSplitViewId(tab.splitViewId),
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
 * Pause the agent loop for a fixed duration. Capped to [1, 300] seconds.
 */
async function _execSleep({ seconds } = {}) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return { error: "seconds is required and must be a number" };
  const intSeconds = Math.floor(n);
  if (intSeconds < 1 || intSeconds > 300) {
    return { error: "seconds must be an integer between 1 and 300 (inclusive)" };
  }
  const startedAt = Date.now();
  await _sleepMs(intSeconds * 1000);
  return {
    success: true,
    requestedSeconds: intSeconds,
    actualMs: Date.now() - startedAt
  };
}

/**
 * Download a file using chrome.downloads API. Delegates to the shared helper
 * so the same code path serves both LLM-invoked downloads and UI-side exports.
 */
async function _execDownload({ fileName, url, content } = {}) {
  return await triggerBrowserDownload({ fileName, url, content });
}

/**
 * Serialize a chrome.downloads DownloadItem into a compact LLM-friendly shape.
 * `filename` is the absolute path on the local filesystem.
 */
function _serializeDownloadItem(item) {
  return {
    id: item.id,
    url: item.url || "",
    finalUrl: item.finalUrl || "",
    filename: item.filename || "",
    state: item.state || "",
    mime: item.mime || "",
    totalBytes: typeof item.totalBytes === "number" ? item.totalBytes : null,
    bytesReceived: typeof item.bytesReceived === "number" ? item.bytesReceived : null,
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    paused: !!item.paused,
    exists: item.exists !== false,
    error: item.error || null,
    danger: item.danger || null
  };
}

/**
 * List the most recent downloads.
 */
async function _execDownloadList({ limit } = {}) {
  if (!chrome?.downloads?.search) {
    return { error: "chrome.downloads API is unavailable in this context" };
  }
  const max = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
  try {
    const items = await chrome.downloads.search({ limit: max, orderBy: ["-startTime"] });
    return {
      count: items.length,
      downloads: items.map(_serializeDownloadItem)
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/**
 * Search downloads with optional filters.
 */
async function _execDownloadSearch({ query, filenameRegex, urlRegex, state, startedAfter, startedBefore, limit } = {}) {
  if (!chrome?.downloads?.search) {
    return { error: "chrome.downloads API is unavailable in this context" };
  }

  const q = { orderBy: ["-startTime"] };

  if (typeof query === "string" && query.trim()) {
    // chrome.downloads.search expects an array of terms; all must match.
    q.query = query.trim().split(/\s+/);
  }
  if (typeof filenameRegex === "string" && filenameRegex.length > 0) {
    q.filenameRegex = filenameRegex;
  }
  if (typeof urlRegex === "string" && urlRegex.length > 0) {
    q.urlRegex = urlRegex;
  }
  if (state && ["in_progress", "interrupted", "complete"].includes(state)) {
    q.state = state;
  }
  if (Number.isFinite(startedAfter)) {
    q.startedAfter = new Date(startedAfter).toISOString();
  }
  if (Number.isFinite(startedBefore)) {
    q.startedBefore = new Date(startedBefore).toISOString();
  }
  q.limit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));

  try {
    const items = await chrome.downloads.search(q);
    return {
      count: items.length,
      query: q,
      downloads: items.map(_serializeDownloadItem)
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}
