/* global chrome */
import { _resolveControllableTab, _normalizeGroupId, _normalizeSplitViewId, _buildLastAccessed } from "./_shared";
import { deflateStringToQueryParam } from "../../../../utils/playgroundCodec";

export async function _execEvalJs({ jsScript }) {
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
