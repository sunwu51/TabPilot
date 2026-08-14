/* global chrome */
import { _resolveControllableTab, _normalizeGroupId, _normalizeSplitViewId, _buildLastAccessed } from "./_shared";
import { deflateStringToQueryParam } from "../../../../utils/playgroundCodec";

const SVAL_RUNTIME_FILE = "vendor/sval.min.js";

export async function _execEvalJs({ tabId, jsScript }) {
  const resolved = await _resolveControllableTab(tabId, "run code on");
  if (resolved.error) return { error: resolved.error };

  // Sval's sandBox:false keeps the interpreted code in the page's main
  // JavaScript world. The runtime file itself is extension-injected, so the
  // page CSP does not get a chance to block its loading.
  const world = "MAIN";
  try {
    const [{ result: svalLoaded }] = await chrome.scripting.executeScript({
      target: { tabId: resolved.tab.id },
      world,
      func: () => typeof globalThis.Sval === "function"
    });
    if (!svalLoaded) {
      await chrome.scripting.executeScript({
        target: { tabId: resolved.tab.id },
        world,
        files: [SVAL_RUNTIME_FILE]
      });
    }

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
 * Self-contained runner injected into Chrome's main page world by
 * chrome.scripting.executeScript after the packaged Sval runtime is loaded.
 * This bypasses page CSP without creating a page-owned script tag.
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

  try {
    if (typeof globalThis.Sval !== "function") {
      return { error: "Sval runtime was not injected", strategy: "sval" };
    }
    const runtime = new globalThis.Sval({ ecmaVer: "latest", sourceType: "script", sandBox: false });
    // sandBox:false evaluates against the current main-world globals. Do not
    // import window/document/etc. again: Sval would redeclare those bindings.
    runtime.run("exports.__result = (async () => {\n" + String(source || "") + "\n})()");
    const result = await runtime.exports.__result;
    return {
      success: true,
      strategy: "sval",
      url: document.URL,
      title: document.title,
      result: normalizeResult(result)
    };
  } catch (e) {
    return {
      error: e && e.message ? e.message : String(e),
      stack: e && e.stack ? String(e.stack).slice(0, 4000) : null,
      strategy: "sval",
      url: document.URL,
      title: document.title
    };
  }
}
export async function openHelloWorldPlayground() {
  return _execHtmlPlayground({
    html: "<h1>Hello World</h1>",
    expanded: true
  });
}

function _buildHtmlPlaygroundUrl({ html = "", css = "", js = "", expanded = false } = {}) {
  const playgroundUrl = new URL(chrome.runtime.getURL("playground.html"));
  playgroundUrl.searchParams.set("html", deflateStringToQueryParam(html));
  playgroundUrl.searchParams.set("css", deflateStringToQueryParam(css));
  playgroundUrl.searchParams.set("js", deflateStringToQueryParam(js));
  playgroundUrl.searchParams.set("expanded", expanded ? "1" : "0");
  return playgroundUrl.toString();
}

/**
 * Open the extension HTML playground with compressed html/css/js query params.
 */
export async function _execHtmlPlayground({ html = "", css = "", js = "", expanded = false } = {}) {
  const url = _buildHtmlPlaygroundUrl({ html, css, js, expanded });
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab?.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return {
    success: true,
    tabId: tab?.id,
    url: tab?.pendingUrl || tab?.url || url,
    expanded: !!expanded
  };
}
