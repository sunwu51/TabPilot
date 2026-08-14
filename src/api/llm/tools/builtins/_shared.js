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

        function getElementRole(element) {
          const explicit = element.getAttribute("role");
          if (explicit) return explicit;
          const tagName = element.tagName.toLowerCase();
          const type = String(element.getAttribute("type") || "").toLowerCase();
          if (tagName === "a" && element.hasAttribute("href")) return "link";
          if (tagName === "button") return "button";
          if (tagName === "textarea") return "textbox";
          if (tagName === "select") return element.multiple ? "listbox" : "combobox";
          if (tagName === "summary") return "button";
          if (tagName === "input") {
            if (["button", "submit", "reset", "image"].includes(type)) return "button";
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (type === "range") return "slider";
            if (type === "number") return "spinbutton";
            if (type === "search") return "searchbox";
            if (type !== "hidden") return "textbox";
          }
          if (element.isContentEditable || element.getAttribute("contenteditable") === "true") return "textbox";
          return tagName;
        }

        function getElementName(element) {
          const labelledBy = String(element.getAttribute("aria-labelledby") || "").trim();
          const labelledText = labelledBy
            ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ")
            : "";
          const labels = element.labels ? Array.from(element.labels).map(label => label.innerText || label.textContent || "").join(" ") : "";
          return truncateText(
            element.getAttribute("aria-label") ||
            labelledText ||
            labels ||
            element.getAttribute("alt") ||
            element.getAttribute("title") ||
            element.getAttribute("placeholder") ||
            element.innerText ||
            element.textContent ||
            element.getAttribute("value") ||
            "",
            500
          );
        }

        function serializeSnapshotNode(element, ref) {
          const node = {
            ref,
            role: getElementRole(element),
            name: getElementName(element),
            tagName: element.tagName.toLowerCase(),
            visible: isElementVisible(element),
            disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
            rect: serializeRect(element)
          };
          if ("value" in element && element.type !== "password" && !["checkbox", "radio"].includes(element.type)) {
            node.value = truncateText(element.value || "", 300);
          }
          if ("checked" in element) node.checked = Boolean(element.checked);
          if ("selected" in element) node.selected = Boolean(element.selected);
          for (const [key, attribute] of [["expanded", "aria-expanded"], ["pressed", "aria-pressed"]]) {
            if (element.hasAttribute(attribute)) node[key] = element.getAttribute(attribute);
          }
          if (element.required || element.getAttribute("aria-required") === "true") node.required = true;
          if (element.readOnly || element.getAttribute("aria-readonly") === "true") node.readonly = true;
          const attributes = serializeAttributes(element);
          if (Object.keys(attributes).length) node.attributes = attributes;
          return node;
        }

        function isSnapshotInteractive(element) {
          const role = getElementRole(element);
          const interactiveRoles = new Set([
            "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch",
            "combobox", "listbox", "option", "slider", "spinbutton", "tab", "menuitem",
            "menuitemcheckbox", "menuitemradio", "treeitem"
          ]);
          return interactiveRoles.has(role) || element.matches(
            "a[href], button, input:not([type=hidden]), textarea, select, summary, " +
            "[contenteditable]:not([contenteditable=false]), [onclick], [tabindex]:not([tabindex='-1'])"
          );
        }

        function getSnapshotSemanticRole(element) {
          const explicitRole = element.getAttribute("role");
          if (explicitRole) return explicitRole;
          const tagName = element.tagName.toLowerCase();
          if (/^h[1-6]$/.test(tagName)) return "heading";
          const roles = {
            header: "banner", nav: "navigation", main: "main", aside: "complementary",
            footer: "contentinfo", article: "article", section: "region", form: "form",
            dialog: "dialog", ul: "list", ol: "list", li: "listitem", table: "table",
            thead: "rowgroup", tbody: "rowgroup", tfoot: "rowgroup", tr: "row",
            th: "columnheader", td: "cell", fieldset: "group", details: "group",
            p: "paragraph", pre: "code", blockquote: "blockquote", img: "img",
            iframe: "iframe"
          };
          return roles[tagName] || null;
        }

        function shouldPreserveSnapshotContainer(element, childEntries) {
          if (element.tagName.toLowerCase() === "iframe") return true;
          const meaningfulChildren = childEntries.filter(child => child.type !== "text" || child.text.trim());
          if (!meaningfulChildren.length) return false;
          if (getSnapshotSemanticRole(element)) return true;
          if (meaningfulChildren.length < 2) return false;
          const hasInteractive = meaningfulChildren.some(child => child.ref || child.containsInteractive);
          const hasContext = meaningfulChildren.some(child =>
            child.type === "text" || child.role === "heading" || child.role === "img" || child.role === "paragraph"
          );
          return hasInteractive && hasContext;
        }

        function findMatchingElements(locator) {
          if (!locator.selector && !locator.text) {
            return { error: "Please provide at least one locator: selector or text" };
          }

          const queryAllDeep = (selector, root = document, results = []) => {
            const matches = Array.from(root.querySelectorAll(selector));
            results.push(...matches);
            for (const element of Array.from(root.querySelectorAll("*"))) {
              if (element.shadowRoot) queryAllDeep(selector, element.shadowRoot, results);
              if (element.tagName?.toLowerCase() === "iframe") {
                try {
                  if (element.contentDocument) queryAllDeep(selector, element.contentDocument, results);
                } catch (e) { /* Cross-origin frames are not script-accessible. */ }
              }
            }
            return results;
          };

          let elements;
          try {
            elements = locator.selector
              ? queryAllDeep(locator.selector)
              : queryAllDeep("body *");
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
          const snapshotSelectorMatch = typeof locator.selector === "string"
            ? /^@([^#\s]+)#([^#\s]+)$/.exec(locator.selector.trim())
            : null;
          const snapshotId = snapshotSelectorMatch?.[1] || locator.snapshotId;
          const ref = snapshotSelectorMatch?.[2] || locator.ref;
          if (ref || snapshotId) {
            const registry = globalThis.__tabManagerInteractionSnapshot;
            if (!ref || !snapshotId || !registry || registry.id !== snapshotId) {
              return { error: "stale_snapshot" };
            }
            const element = registry.nodes.get(ref);
            if (!element || !element.isConnected) return { error: "stale_snapshot" };
            return { element, index: null, totalMatches: 1, ref, snapshotId: registry.id };
          }
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
          if (pageAction === "tab_snapshot") {
            const maxResults = Math.min(1000, Math.max(1, Number.isInteger(pageParams.maxResults) ? pageParams.maxResults : 500));
            const maxTextLength = Math.min(2000, Math.max(50, Number.isInteger(pageParams.maxTextLength) ? pageParams.maxTextLength : 500));
            const maxSnapshotChars = Math.min(100000, Math.max(2000, Number.isInteger(pageParams.maxSnapshotChars) ? pageParams.maxSnapshotChars : 30000));
            const pageResponseBudget = Math.max(1000, maxSnapshotChars - 1000);
            const includeHidden = pageParams.includeHidden === true;
            const snapshotId = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            const nodes = new Map();
            const serialized = [];
            let visitedCount = 0;
            let textTruncated = false;
            let nodeLimitTruncated = false;
            const capSnapshotText = (value) => {
              const normalized = String(value || "").replace(/\s+/g, " ").trim();
              if (normalized.length <= maxTextLength) return normalized;
              textTruncated = true;
              return maxTextLength <= 3 ? normalized.slice(0, maxTextLength) : normalized.slice(0, maxTextLength - 3) + "...";
            };

            const buildSnapshotTree = (domNode) => {
              if (visitedCount >= maxResults) {
                nodeLimitTruncated = true;
                return [];
              }
              if (domNode.nodeType === Node.TEXT_NODE) {
                const text = capSnapshotText(domNode.textContent || "");
                if (!text || !domNode.parentElement || (!includeHidden && !isElementVisible(domNode.parentElement))) return [];
                visitedCount += 1;
                return [{ type: "text", text, containsInteractive: false }];
              }
              if (domNode.nodeType !== Node.ELEMENT_NODE) return [];
              const element = domNode;
              const tagName = element.tagName.toLowerCase();
              if (["script", "style", "noscript", "template"].includes(tagName)) return [];
              if (element.getAttribute("aria-hidden") === "true" || (!includeHidden && !isElementVisible(element))) return [];

              let childEntries = [];
              let childSource = element.shadowRoot ? element.shadowRoot.childNodes : element.childNodes;
              let frameDocument = null;
              let frameInaccessible = false;
              if (tagName === "iframe") {
                try {
                  frameDocument = element.contentDocument;
                  if (frameDocument?.body) childSource = frameDocument.body.childNodes;
                  else frameInaccessible = true;
                } catch (e) {
                  frameInaccessible = true;
                }
              }
              for (const child of childSource) childEntries.push(...buildSnapshotTree(child));
              if (tagName === "iframe" && frameDocument) {
                childEntries = [{
                  type: "element",
                  role: "document",
                  ...(frameDocument.title ? { name: capSnapshotText(frameDocument.title) } : {}),
                  url: frameDocument.URL,
                  ...(childEntries.length ? { children: childEntries } : {}),
                  containsInteractive: childEntries.some(child => child.ref || child.containsInteractive)
                }];
              }

              const interactive = isSnapshotInteractive(element);
              const semanticRole = getSnapshotSemanticRole(element);
              if (!interactive && !shouldPreserveSnapshotContainer(element, childEntries)) return childEntries;
              if (visitedCount >= maxResults) {
                nodeLimitTruncated = true;
                return childEntries;
              }

              visitedCount += 1;
              let ref = null;
              if (interactive) {
                ref = `e${serialized.length + 1}`;
                nodes.set(ref, element);
                const serializedNode = serializeSnapshotNode(element, ref);
                for (const key of ["name", "value", "text"]) {
                  if (typeof serializedNode[key] !== "string") continue;
                  serializedNode[key] = capSnapshotText(serializedNode[key]);
                }
                serialized.push(serializedNode);
              }
              const entry = {
                type: "element",
                role: interactive ? getElementRole(element) : (semanticRole || "group"),
                tagName,
                ...(ref ? { ref } : {}),
                ...(/^h[1-6]$/.test(tagName) ? { level: Number(tagName.slice(1)) } : {}),
                ...(childEntries.length ? { children: childEntries } : {}),
                containsInteractive: interactive || childEntries.some(child => child.ref || child.containsInteractive)
              };
              if (tagName === "iframe") {
                const frameName = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("name") || "";
                if (frameName) entry.name = capSnapshotText(frameName);
                if (element.src) entry.src = element.src;
                if (frameInaccessible) entry.inaccessible = true;
              }
              const name = getElementName(element);
              if (interactive && name) {
                entry.name = capSnapshotText(name);
              }
              return [entry];
            };

            const internalTree = buildSnapshotTree(document.body || document.documentElement);
            const toPublicSnapshotEntry = (entry) => {
              const publicEntry = { ...entry };
              const children = publicEntry.children;
              delete publicEntry.containsInteractive;
              delete publicEntry.children;
              if (children?.length) publicEntry.children = children.map(toPublicSnapshotEntry);
              return publicEntry;
            };
            const tree = internalTree.map(toPublicSnapshotEntry);
            const formatSnapshotTree = (entries, depth = 0) => {
              const lines = [];
              const indent = "  ".repeat(depth);
              for (const entry of entries) {
                if (entry.type === "text") {
                  lines.push(`${indent}- text: ${JSON.stringify(entry.text)}`);
                  continue;
                }
                let line = `${indent}- ${entry.role || entry.tagName || "generic"}`;
                if (entry.name) line += ` ${JSON.stringify(entry.name)}`;
                const annotations = [];
                if (entry.ref) annotations.push(`selector=${JSON.stringify(`@${snapshotId}#${entry.ref}`)}`);
                if (entry.level) annotations.push(`level=${entry.level}`);
                if (entry.src) annotations.push(`src=${JSON.stringify(entry.src)}`);
                if (entry.url) annotations.push(`url=${JSON.stringify(entry.url)}`);
                if (entry.inaccessible) annotations.push("inaccessible");
                if (entry.ref) {
                  const state = serialized.find(node => node.ref === entry.ref);
                  if (state?.checked === true) annotations.push("checked");
                  if (state?.selected === true) annotations.push("selected");
                  if (state?.disabled === true) annotations.push("disabled");
                  if (state?.required === true) annotations.push("required");
                  if (state?.readonly === true) annotations.push("readonly");
                  if (state?.expanded != null) annotations.push(`expanded=${state.expanded}`);
                  if (state?.pressed != null) annotations.push(`pressed=${state.pressed}`);
                  if (state?.value) annotations.push(`value=${JSON.stringify(state.value)}`);
                }
                if (annotations.length) line += ` [${annotations.join(", ")}]`;
                lines.push(line);
                if (entry.children?.length) lines.push(...formatSnapshotTree(entry.children, depth + 1));
              }
              return lines;
            };
            let returnedNodes = serialized;
            let sizeLimitTruncated = false;
            const response = {
              success: true,
              snapshotId,
              url: document.URL,
              title: document.title,
              count: returnedNodes.length,
              treeNodeCount: visitedCount,
              truncated: textTruncated || nodeLimitTruncated,
              truncation: {
                text: textTruncated,
                nodeLimit: nodeLimitTruncated,
                sizeLimit: false
              },
              limits: { maxResults, maxTextLength, maxSnapshotChars },
              content: formatSnapshotTree(tree).join("\n")
            };

            const removeLastTreeEntry = (entries) => {
              if (!entries.length) return false;
              const last = entries[entries.length - 1];
              if (last.children?.length && removeLastTreeEntry(last.children)) {
                if (!last.children.length) delete last.children;
                return true;
              }
              entries.pop();
              return true;
            };
            while (JSON.stringify(response).length > pageResponseBudget && removeLastTreeEntry(tree)) {
              sizeLimitTruncated = true;
              response.content = formatSnapshotTree(tree).join("\n");
            }
            const syncReturnedNodes = () => {
              const retainedRefs = new Set();
              const collectRefs = (entries) => {
                for (const entry of entries) {
                  if (entry.ref) retainedRefs.add(entry.ref);
                  if (entry.children) collectRefs(entry.children);
                }
              };
              collectRefs(tree);
              returnedNodes = serialized.filter(node => retainedRefs.has(node.ref));
              response.count = returnedNodes.length;
            };
            if (sizeLimitTruncated) {
              syncReturnedNodes();
              response.truncated = true;
              response.truncation.sizeLimit = true;
              while (JSON.stringify(response).length > pageResponseBudget && removeLastTreeEntry(tree)) {
                response.content = formatSnapshotTree(tree).join("\n");
                syncReturnedNodes();
              }
            }
            const returnedRegistry = new Map(returnedNodes.map(node => [node.ref, nodes.get(node.ref)]));
            globalThis.__tabManagerInteractionSnapshot = { id: snapshotId, nodes: returnedRegistry };
            return response;
          }

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
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
            };
          }

          if (pageAction === "dom_double_click" || pageAction === "dom_right_click") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            await sleep(350);
            const rect = element.getBoundingClientRect();
            const rightClick = pageAction === "dom_right_click";
            const init = { bubbles: true, cancelable: true, composed: true, button: rightClick ? 2 : 0, buttons: rightClick ? 2 : 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
            const names = rightClick ? ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"] : ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"];
            for (const name of names) {
              const EventConstructor = name.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
              element.dispatchEvent(new EventConstructor(name, { ...init, detail: name === "dblclick" ? 2 : (name === "click" ? 1 : 0) }));
            }
            return { success: true, action: rightClick ? "right_click" : "double_click", synthetic: true, events: names, totalMatches: resolved.totalMatches, target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) } };
          }

          if (pageAction === "dom_scroll_into_view") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            resolved.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            await sleep(350);
            return { success: true, action: "scroll_into_view", totalMatches: resolved.totalMatches, target: { ...serializeElement(resolved.element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }, scroll: getScrollState() };
          }

          if (pageAction === "dom_check") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            const type = String(element.type || "").toLowerCase();
            if (element.tagName.toLowerCase() !== "input" || !["checkbox", "radio"].includes(type)) return { error: "Element is not a checkbox or radio" };
            if (type === "radio" && pageParams.checked === false) return { error: "A radio cannot be unchecked directly; check another radio in the group" };
            const checked = pageParams.checked === true;
            const changed = element.checked !== checked;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            element.checked = checked;
            if (changed) {
              element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return { success: true, action: "check", checked: element.checked, changed, totalMatches: resolved.totalMatches, target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) } };
          }

          if (pageAction === "dom_wait") {
            const state = ["present", "absent", "visible", "hidden", "enabled", "disabled"].includes(pageParams.state) ? pageParams.state : "present";
            const timeoutMs = Math.min(10000, Math.max(0, Number.isFinite(pageParams.timeoutMs) ? pageParams.timeoutMs : 5000));
            const pollIntervalMs = Math.min(1000, Math.max(50, Number.isFinite(pageParams.pollIntervalMs) ? pageParams.pollIntervalMs : 100));
            const startedAt = Date.now();
            const deadline = startedAt + timeoutMs;
            while (Date.now() <= deadline) {
              const { elements, error } = findMatchingElements(pageParams);
              if (error) return { error };
              const element = elements[Number.isInteger(pageParams.index) ? pageParams.index : 0];
              const visible = element ? isElementVisible(element) : false;
              const disabled = element ? (Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true") : false;
              const satisfied = state === "absent" ? !element : state === "hidden" ? (!element || !visible) : state === "visible" ? visible : state === "enabled" ? (Boolean(element) && !disabled) : state === "disabled" ? (Boolean(element) && disabled) : Boolean(element);
              if (satisfied) return { success: true, action: "wait", state, elapsedMs: Date.now() - startedAt, target: element ? serializeElement(element, Number.isInteger(pageParams.index) ? pageParams.index : 0) : null };
              await sleep(pollIntervalMs);
            }
            return { error: `Timed out waiting for element state: ${state}`, state, timeoutMs };
          }

          if (pageAction === "dom_hover") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            await sleep(350);
            const rect = element.getBoundingClientRect();
            const eventInit = {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2
            };
            const eventNames = ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"];
            for (const eventName of eventNames) {
              const EventConstructor = eventName.startsWith("pointer") && typeof PointerEvent === "function"
                ? PointerEvent
                : MouseEvent;
              element.dispatchEvent(new EventConstructor(eventName, eventInit));
            }
            return {
              success: true,
              action: "hover",
              synthetic: true,
              events: eventNames,
              totalMatches: resolved.totalMatches,
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
            };
          }

          if (pageAction === "dom_focus") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            if (typeof element.focus !== "function") return { error: "Element cannot be focused" };
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            await sleep(350);
            try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            return {
              success: true,
              action: "focus",
              focused: document.activeElement === element,
              totalMatches: resolved.totalMatches,
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
            };
          }

          if (pageAction === "dom_set_value") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            const tagName = element.tagName.toLowerCase();
            const contentEditable = element.isContentEditable || element.getAttribute("contenteditable") === "true";
            if (!["input", "textarea", "select"].includes(tagName) && !contentEditable) {
              return { error: `Element is not a form field: <${tagName}>` };
            }
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            if (typeof element.focus === "function") {
              try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            }
            await sleep(350);
            if (contentEditable) {
              element.textContent = String(pageParams.value ?? "");
              element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: String(pageParams.value ?? "") }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              setFormElementValue(element, pageParams.value);
            }
            return {
              success: true,
              action: "set_value",
              totalMatches: resolved.totalMatches,
              value: truncateText(contentEditable ? element.textContent : (element.value || ""), 500),
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
            };
          }

          if (pageAction === "dom_select_option") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            if (element.tagName.toLowerCase() !== "select") return { error: "Element is not a select field" };
            if (!Array.isArray(pageParams.values) || pageParams.values.length === 0) {
              return { error: "Please provide at least one option value or label" };
            }
            const requested = pageParams.values.map(value => String(value));
            const requestedSet = new Set(requested);
            const options = Array.from(element.options);
            const matched = options.filter(option => requestedSet.has(option.value) || requestedSet.has(option.text.trim()));
            const matchedRequested = new Set();
            for (const option of matched) {
              if (requestedSet.has(option.value)) matchedRequested.add(option.value);
              if (requestedSet.has(option.text.trim())) matchedRequested.add(option.text.trim());
            }
            const missing = requested.filter(value => !matchedRequested.has(value));
            if (missing.length) return { error: `Options not found: ${missing.join(", ")}` };
            if (!element.multiple && matched.length > 1) matched.splice(1);
            const selectedOptions = new Set(matched);
            for (const option of options) option.selected = selectedOptions.has(option);
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            if (typeof element.focus === "function") {
              try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            }
            element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return {
              success: true,
              action: "select_option",
              values: Array.from(element.selectedOptions).map(option => option.value),
              labels: Array.from(element.selectedOptions).map(option => option.text.trim()),
              totalMatches: resolved.totalMatches,
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
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
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
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
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) }
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
              target: { ...serializeElement(element, resolved.index), ...(resolved.ref ? { ref: resolved.ref } : {}) },
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
