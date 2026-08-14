/* global chrome */
import {
  _resolveControllableTab,
  _getActiveTabInCurrentExtensionWindow,
  _buildCapturedAt,
  _serializeTabMetadata,
  _normalizeGroupId,
  _normalizeSplitViewId,
  _buildLastAccessed,
  _executePageAction,
  _sleepMs,
  _loadGroupSnapshot
} from "./_shared";

function _parseDataUrl(dataUrl) {
  const raw = typeof dataUrl === "string" ? dataUrl : "";
  if (!raw.startsWith("data:")) return null;
  const marker = ";base64,";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex <= "data:".length) return null;
  const mediaType = raw.slice("data:".length, markerIndex);
  const base64Data = raw.slice(markerIndex + marker.length);
  if (!mediaType || !base64Data) return null;
  const padding = base64Data.endsWith("==") ? 2 : (base64Data.endsWith("=") ? 1 : 0);
  return {
    mediaType,
    base64Data,
    approxBytes: Math.max(0, Math.floor(base64Data.length * 3 / 4) - padding)
  };
}
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
export async function _execTabList({ maxSize = -1, briefUrl = false } = {}) {
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
export async function _execTabExtract({ tabId }) {
  const resolved = await _waitForReadableTab(tabId);
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

async function _waitForReadableTab(tabId, timeoutMs = 10000) {
  let resolvedTabId = tabId;
  if (resolvedTabId == null) {
    const activeTab = await _getActiveTabInCurrentExtensionWindow();
    if (!activeTab?.id) return { error: "No active tab found" };
    resolvedTabId = activeTab.id;
  }

  let currentTab;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      currentTab = await chrome.tabs.get(resolvedTabId);
    } catch (error) {
      return { error: error?.message || "Tab not found" };
    }

    const url = currentTab.url || currentTab.pendingUrl || "";
    if (/^https?:\/\//i.test(url)) {
      if (currentTab.status !== "loading") return { tab: currentTab };
    } else if (currentTab.url && !/^https?:\/\//i.test(currentTab.url)) {
      return { error: `Cannot read this page (${currentTab.url.split("://")[0] || "unknown"} protocol)` };
    }

    await _sleepMs(100);
  }

  const url = currentTab?.url || currentTab?.pendingUrl || "";
  if (!/^https?:\/\//i.test(url)) {
    return { error: `Cannot read this page (${url.split("://")[0] || "unknown"} protocol)` };
  }
  return { error: "Timed out waiting for the page to finish loading", hint: "Retry tab_extract after the page has loaded." };
}
export async function _execTabScroll({ tabId, deltaY, pageFraction, position, behavior }) {
  const resolved = await _resolveControllableTab(tabId, "scroll");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "tab_scroll",
    { deltaY, pageFraction, position, behavior },
    "This page may need to be refreshed before scrolling can be controlled."
  );
}
export async function _execTabOpen({ url, active }) {
  if (!/^(https?:\/\/|data:|file:\/\/)/i.test(url)) url = "https://" + url;
  const shouldFocus = active !== false; // default true
  const tab = await chrome.tabs.create({ url, active: shouldFocus });
  if (shouldFocus) await chrome.windows.update(tab.windowId, { focused: true });

  let loadedTab = tab;
  if (/^https?:\/\//i.test(url) && tab.id != null) {
    const waited = await _waitForReadableTab(tab.id, 15000);
    if (waited.error) {
      return {
        error: waited.error,
        hint: waited.hint || "The tab was created, but the page did not become readable in time.",
        tabId: tab.id,
        url: tab.pendingUrl || tab.url || url
      };
    }
    loadedTab = waited.tab;
  }

  return {
    success: true,
    active: shouldFocus,
    tabId: loadedTab.id,
    url: loadedTab.url || loadedTab.pendingUrl || url,
    title: loadedTab.title || "",
    windowId: loadedTab.windowId,
    groupId: _normalizeGroupId(loadedTab.groupId),
    splitViewId: _normalizeSplitViewId(loadedTab.splitViewId),
    ..._buildLastAccessed(loadedTab.lastAccessed)
  };
}
export async function _execTabFocus({ tabId }) {
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

async function _execTabNavigation(tabId, action) {
  const resolved = await _resolveControllableTab(tabId, "navigate");
  if (resolved.error) return { error: resolved.error };
  if (action === "reload") await chrome.tabs.reload(resolved.tab.id);
  else if (action === "back") await chrome.tabs.goBack(resolved.tab.id);
  else await chrome.tabs.goForward(resolved.tab.id);
  return { success: true, action, tabId: resolved.tab.id, windowId: resolved.tab.windowId, previousUrl: resolved.tab.url };
}

export async function _execTabReload({ tabId }) { return _execTabNavigation(tabId, "reload"); }
export async function _execTabBack({ tabId }) { return _execTabNavigation(tabId, "back"); }
export async function _execTabForward({ tabId }) { return _execTabNavigation(tabId, "forward"); }

export async function _execTabWait({ tabId, url, match = "contains", timeoutMs = 5000, pollIntervalMs = 100 }) {
  const resolved = await _resolveControllableTab(tabId, "wait for");
  if (resolved.error) return { error: resolved.error };
  if (!url) return { error: "Please provide a URL pattern" };
  const limit = Math.min(10000, Math.max(0, Number(timeoutMs) || 5000));
  const interval = Math.min(1000, Math.max(50, Number(pollIntervalMs) || 100));
  const startedAt = Date.now();
  const deadline = startedAt + limit;
  let currentUrl = resolved.tab.url || resolved.tab.pendingUrl || "";
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(resolved.tab.id);
    currentUrl = tab.url || tab.pendingUrl || "";
    const matches = match === "exact" ? currentUrl === url : currentUrl.includes(url);
    if (matches) return { success: true, action: "wait_url", match, url: currentUrl, elapsedMs: Date.now() - startedAt, tabId: tab.id, windowId: tab.windowId };
    await _sleepMs(interval);
  }
  return { error: `Timed out waiting for URL: ${url}`, match, timeoutMs: limit, url: currentUrl };
}
export async function _execTabClose({ tabIds }) {
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
export async function _execTabGroup({ tabIds, name, color }) {
  const groupId = await chrome.tabs.group({ tabIds });
  const updateProps = { title: name };
  if (color) updateProps.color = color;
  await chrome.tabGroups.update(groupId, updateProps);
  const group = await _loadGroupSnapshot(groupId);
  return { success: true, groupId, name, tabCount: tabIds.length, group };
}
export async function _execTabGetActive() {
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
export async function _execTabScreenshot(args = {}) {
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
export async function captureFullPageScreenshotToTab(args = {}) {
  const result = await _execTabScreenshot({ ...args, fullPage: true });
  if (result?.error) return result;
  if (!result?.dataUrl) {
    return { error: "Screenshot completed but no image data was returned." };
  }
  const tab = await chrome.tabs.create({ url: result.dataUrl, active: true });
  if (tab?.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return {
    ...result,
    imageTabId: tab?.id,
    imageUrl: tab?.pendingUrl || tab?.url || result.dataUrl
  };
}
