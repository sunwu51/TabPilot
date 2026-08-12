/* global chrome */
import { resolveActiveLlmConfig } from "../../core/modelProfiles";
import { API_TYPES } from "../../core/config";
import { resolveLlmRequestUrl } from "../../core/endpoint";
import { _resolveControllableTab } from "./_shared";

const PAGE_AGENT_RUNTIME_FILE = "vendor/page-agent.demo.js";

export async function initializePageAgent({ tabId } = {}) {
  const resolved = await _resolveControllableTab(tabId, "initialize Page Agent on");
  if (resolved.error) return { error: resolved.error, code: "PAGE_AGENT_TAB_UNAVAILABLE" };

  const bridgeId = crypto.randomUUID();
  try {
    await enablePageAgentBridge(resolved.tab.id, bridgeId);
    await ensurePageAgentRuntime(resolved.tab.id);
    const { llmConfig = {} } = await chrome.storage.local.get({ llmConfig: {} });
    const activeConfig = resolveActiveLlmConfig(llmConfig);
    const baseUrl = normalizePageAgentBaseUrl(activeConfig.apiType, activeConfig.baseUrl);
    if (!baseUrl || !activeConfig.model) {
      return { error: "No usable model is configured for Page Agent", code: "PAGE_AGENT_NO_CHAT_MODEL" };
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: resolved.tab.id },
      world: "MAIN",
      func: initializePageAgentPanel,
      args: [{
        bridgeId,
        model: activeConfig.model,
        baseURL: baseUrl,
        language: "zh-CN"
      }]
    });
    const pageState = result?.result || {};
    await enablePageAgentBridge(resolved.tab.id, pageState.bridgeId || bridgeId);
    if (pageState.bridgeId && pageState.bridgeId !== bridgeId) {
      await disablePageAgentBridge(resolved.tab.id, bridgeId);
    }
    if (pageState.previousBridgeId && pageState.previousBridgeId !== pageState.bridgeId) {
      await disablePageAgentBridge(resolved.tab.id, pageState.previousBridgeId);
    }
    return { success: true, tabId: resolved.tab.id, url: resolved.tab.url || "", ...pageState };
  } catch (error) {
    await disablePageAgentBridge(resolved.tab.id, bridgeId);
    return {
      error: `Page Agent 无法注入: ${error?.message || String(error)}`,
      code: "PAGE_AGENT_INJECTION_FAILED"
    };
  }
}

function initializePageAgentPanel(config) {
  function configurePanel(agent) {
    const panel = agent?.panel;
    if (!panel) return;
    const wrapper = panel.wrapper;
    if (wrapper && !panel.__tabManagerPositionConfigured) {
      panel.__tabManagerPositionConfigured = true;
      const show = panel.show.bind(panel);
      panel.show = () => {
        show();
        wrapper.style.left = "auto";
        wrapper.style.right = "16px";
        wrapper.style.transform = "translateY(0)";
      };
      wrapper.style.left = "auto";
      wrapper.style.right = "16px";
      wrapper.style.transform = "translateY(20px)";
    }
  }

  function createProxyFetch() {
    return async (url, init = {}) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeoutId = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("Timed out waiting for the extension Page Agent request proxy"));
      }, 60000);
      function onMessage(event) {
        const payload = event.data;
        if (event.source !== window || payload?.type !== "tabpilot_page_agent_proxy:response" || payload.bridgeId !== config.bridgeId || payload.requestId !== requestId) return;
        clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        if (!payload.success) {
          reject(new Error(payload.error || "Extension Page Agent request proxy failed"));
          return;
        }
        resolve(new Response(payload.body || "", {
          status: payload.status,
          statusText: payload.statusText,
          headers: payload.headers || {}
        }));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({
        type: "tabpilot_page_agent_proxy:request",
        bridgeId: config.bridgeId,
        requestId,
        request: {
          url: String(url),
          method: String(init.method || "GET"),
          body: typeof init.body === "string" ? init.body : ""
        }
      }, "*");
    });
  }

  if (!window.PageAgent) throw new Error("Page Agent runtime was not injected");
  const configKey = JSON.stringify({ model: config.model, baseURL: config.baseURL, language: config.language });
  const state = window.__tabManagerPageAgentState;
  if (state?.agent && state.configKey === configKey) {
    state.agent.panel?.show?.();
    return { panelVisible: true, reused: true, bridgeId: state.bridgeId };
  }
  const previousBridgeId = state?.bridgeId;
  state?.agent?.dispose?.();
  const agent = new window.PageAgent({ ...config, customFetch: createProxyFetch() });
  window.__tabManagerPageAgent = agent;
  window.__tabManagerPageAgentState = { agent, bridgeId: config.bridgeId, configKey };
  configurePanel(agent);
  agent.panel?.show?.();
  return { panelVisible: true, reused: false, bridgeId: config.bridgeId, previousBridgeId };
}

export async function _execPageAgent({ tabId, instruction }) {
  const resolved = await _resolveControllableTab(tabId, "run Page Agent on");
  if (resolved.error) {
    return {
      error: resolved.error,
      code: "PAGE_AGENT_TAB_UNAVAILABLE",
      hint: "Use tab_list to choose an accessible http/https tab, or use tab_extract/dom_query/dom_click/dom_set_value instead."
    };
  }

  const task = String(instruction || "").trim();
  if (!task) {
    return {
      error: "Page Agent instruction is required",
      code: "PAGE_AGENT_INVALID_INSTRUCTION"
    };
  }

  const { llmConfig = {} } = await chrome.storage.local.get({ llmConfig: {} });
  const activeConfig = resolveActiveLlmConfig(llmConfig);
  const baseUrl = normalizePageAgentBaseUrl(activeConfig.apiType, activeConfig.baseUrl);

  if (!baseUrl || !activeConfig.model) {
    return {
      error: "No usable model is configured for Page Agent",
      code: "PAGE_AGENT_NO_CHAT_MODEL",
      hint: "Use the existing tab_extract/dom_* tools, or configure an LLM model."
    };
  }

  const bridgeId = crypto.randomUUID();
  const navigationGuard = createPageAgentNavigationGuard(resolved.tab.id, resolved.tab.url || "");
  try {
    await enablePageAgentBridge(resolved.tab.id, bridgeId);
    await ensurePageAgentRuntime(resolved.tab.id);
    const [result] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: resolved.tab.id },
        world: "MAIN",
        func: executePageAgentInPage,
        args: [{
          instruction: task,
          bridgeId,
          config: {
            model: activeConfig.model,
            baseURL: baseUrl,
            language: "zh-CN"
          }
        }]
      }),
      navigationGuard.promise
    ]);

    const pageState = result?.result || { error: "Page Agent returned no result", code: "PAGE_AGENT_EMPTY_RESULT" };
    if (pageState.bridgeId) {
      await enablePageAgentBridge(resolved.tab.id, pageState.bridgeId);
      if (pageState.previousBridgeId && pageState.previousBridgeId !== pageState.bridgeId) {
        await disablePageAgentBridge(resolved.tab.id, pageState.previousBridgeId);
      }
      if (pageState.bridgeId !== bridgeId) await disablePageAgentBridge(resolved.tab.id, bridgeId);
    }
    return {
      tabId: resolved.tab.id,
      url: resolved.tab.url || "",
      ...pageState
    };
  } catch (error) {
    await disablePageAgentBridge(resolved.tab.id, bridgeId);
    if (error instanceof PageAgentLifecycleError) {
      return { error: error.message, code: error.code, ...error.details };
    }
    return {
      error: `Page Agent 无法注入或执行: ${error?.message || String(error)}`,
      code: "PAGE_AGENT_INJECTION_FAILED",
      hint: "该页面可能禁止脚本注入或处于 Chrome 特殊页面。请改用 tab_extract/dom_query/dom_click/dom_set_value/eval_js 等工具。"
    };
  } finally {
    navigationGuard.dispose();
  }
}

function createPageAgentNavigationGuard(tabId, previousUrl) {
  let disposed = false;
  let rejectPromise;
  const promise = new Promise((_, reject) => {
    rejectPromise = reject;
  });
  const onCommitted = details => {
    if (disposed || details.tabId !== tabId || details.frameId !== 0) return;
    rejectPromise(new PageAgentLifecycleError(
      "Page Agent task interrupted because the target tab navigated",
      "PAGE_AGENT_TAB_NAVIGATED",
      { tabId, previousUrl, currentUrl: details.url || "" }
    ));
  };
  const onRemoved = removedTabId => {
    if (disposed || removedTabId !== tabId) return;
    rejectPromise(new PageAgentLifecycleError(
      "Page Agent task interrupted because the target tab was closed",
      "PAGE_AGENT_TAB_CLOSED",
      { tabId, previousUrl }
    ));
  };
  chrome.webNavigation?.onCommitted?.addListener?.(onCommitted);
  chrome.tabs.onRemoved.addListener(onRemoved);
  return {
    promise,
    dispose() {
      disposed = true;
      chrome.webNavigation?.onCommitted?.removeListener?.(onCommitted);
      chrome.tabs.onRemoved.removeListener?.(onRemoved);
    }
  };
}

class PageAgentLifecycleError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function enablePageAgentBridge(tabId, bridgeId) {
  const message = { type: "page_agent_proxy_enable", bridgeId };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
  }

  // Tabs that were open before an extension update may not have the new content script.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  await chrome.tabs.sendMessage(tabId, message);
}

function isMissingContentScriptError(error) {
  const message = String(error?.message || error || "");
  return /receiving end does not exist|could not establish connection/i.test(message);
}

async function disablePageAgentBridge(tabId, bridgeId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "page_agent_proxy_disable", bridgeId });
  } catch {
    // The page may have navigated or been closed.
  }
}

async function ensurePageAgentRuntime(tabId) {
  const [{ result: pageAgentLoaded }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => typeof window.PageAgent === "function"
  });
  if (pageAgentLoaded) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: [PAGE_AGENT_RUNTIME_FILE]
  });
}

function normalizePageAgentBaseUrl(apiType, value) {
  return resolveLlmRequestUrl(apiType, value)
    .replace(/\/(chat\/completions|responses|messages)\/?$/i, "");
}

async function executePageAgentInPage({ instruction, bridgeId, config }) {
  function configurePanel(agent) {
    const panel = agent?.panel;
    if (!panel) return;
    const wrapper = panel.wrapper;
    if (wrapper && !panel.__tabManagerPositionConfigured) {
      panel.__tabManagerPositionConfigured = true;
      const show = panel.show.bind(panel);
      panel.show = () => {
        show();
        wrapper.style.left = "auto";
        wrapper.style.right = "16px";
        wrapper.style.transform = "translateY(0)";
      };
      wrapper.style.left = "auto";
      wrapper.style.right = "16px";
      wrapper.style.transform = "translateY(20px)";
    }
  }

  function createProxyFetch() {
    return async (url, init = {}) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const responseType = "tabpilot_page_agent_proxy:response";
      const timeoutId = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("Timed out waiting for the extension Page Agent request proxy"));
      }, 60000);
      function onMessage(event) {
        const payload = event.data;
        if (event.source !== window || payload?.type !== responseType || payload.bridgeId !== bridgeId || payload.requestId !== requestId) return;
        clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        if (!payload.success) {
          reject(new Error(payload.error || "Extension Page Agent request proxy failed"));
          return;
        }
        resolve(new Response(payload.body || "", {
          status: payload.status,
          statusText: payload.statusText,
          headers: payload.headers || {}
        }));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({
        type: "tabpilot_page_agent_proxy:request",
        bridgeId,
        requestId,
        request: {
          url: String(url),
          method: String(init.method || "GET"),
          body: typeof init.body === "string" ? init.body : ""
        }
      }, "*");
    });
  }

  try {
    if (!window.PageAgent) {
      throw new Error("Page Agent runtime was not injected");
    }

    const configKey = JSON.stringify({ model: config.model, baseURL: config.baseURL, language: config.language });
    const state = window.__tabManagerPageAgentState;
    let agent = state?.agent;
    let previousBridgeId;
    if (!agent || state.configKey !== configKey || agent.status === "disposed") {
      previousBridgeId = state?.bridgeId;
      state?.agent?.dispose?.();
      agent = new window.PageAgent({ ...config, customFetch: createProxyFetch() });
      window.__tabManagerPageAgent = agent;
      window.__tabManagerPageAgentState = { agent, bridgeId, configKey };
      configurePanel(agent);
    }
    const result = await agent.execute(instruction);
    return {
      success: result?.success !== false,
      data: result?.data ?? result,
      status: agent.status,
      bridgeId: window.__tabManagerPageAgentState.bridgeId,
      previousBridgeId
    };
  } catch (error) {
    return {
      error: error?.message || String(error),
      code: "PAGE_AGENT_PAGE_ERROR",
      hint: "Page Agent 在页面内执行失败。请检查页面是否支持脚本注入，或改用 tab_extract/dom_* 工具。"
    };
  }
}
