/* global chrome */

export function withTimeout(promise, timeoutMs, message = "Operation timed out") {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}
export function _buildCapturedAt() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}
export function _buildLastAccessed(lastAccessed) {
  if (typeof lastAccessed !== "number") {
    return { lastAccessed: null, lastAccessedIso: null };
  }
  return {
    lastAccessed,
    lastAccessedIso: new Date(lastAccessed).toISOString()
  };
}
export function _normalizeGroupId(groupId) {
  return typeof groupId === "number" && groupId >= 0 ? groupId : null;
}
export function _normalizeSplitViewId(splitViewId) {
  if (typeof splitViewId !== "number") return null;
  const noneId = chrome?.tabs?.SPLIT_VIEW_ID_NONE;
  if (typeof noneId === "number" && splitViewId === noneId) return null;
  if (splitViewId < 0) return null;
  return splitViewId;
}
export function _serializeTabMetadata(tab) {
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
export function _serializeGroupMetadata(group, tabs = [], currentWindowId = null) {
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
export async function _loadAllGroupSnapshots() {
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
export async function _loadGroupSnapshot(groupId) {
  const groups = await _loadAllGroupSnapshots();
  return groups.find(group => group.id === groupId) || null;
}
export function _serializeWindowMetadata(win, currentWindowId = null) {
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
export async function _resolveControllableTab(tabId, actionLabel = "control") {
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
export async function _getActiveTabInCurrentExtensionWindow() {
  const currentWindow = await _getCurrentExtensionWindow();
  if (currentWindow?.id != null) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
    if (tab?.id) return tab;
  }

  return null;
}
export async function _getCurrentExtensionWindow() {
  try {
    return await chrome.windows.getCurrent({});
  } catch (_e) {
    return null;
  }
}
export async function _executePageAction(tab, action, params, failureHint) {
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
export function _sleepMs(ms) {
  const n = Math.max(0, Math.floor(ms));
  if (!n) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}
