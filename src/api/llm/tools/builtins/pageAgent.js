/* global chrome */
import { resolveActiveLlmConfig } from "../../core/modelProfiles";
import { API_TYPES } from "../../core/config";
import { resolveLlmRequestUrl } from "../../core/endpoint";
import { _resolveControllableTab } from "./_shared";

const PAGE_AGENT_RUNTIME_FILE = "vendor/page-agent.demo.js";

export async function initializePageAgent({ tabId } = {}) {
  const resolved = await _resolveControllableTab(tabId, "initialize Page Agent on");
  if (resolved.error) return { error: resolved.error, code: "PAGE_AGENT_TAB_UNAVAILABLE" };

  try {
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
        model: activeConfig.model,
        baseURL: baseUrl,
        language: "zh-CN"
      }]
    });
    return { success: true, tabId: resolved.tab.id, url: resolved.tab.url || "", ...(result?.result || {}) };
  } catch (error) {
    return {
      error: `Page Agent 无法注入: ${error?.message || String(error)}`,
      code: "PAGE_AGENT_INJECTION_FAILED"
    };
  }
}

function initializePageAgentPanel(config) {
  if (!window.PageAgent) throw new Error("Page Agent runtime was not injected");
  if (!window.__tabManagerPageAgent || window.__tabManagerPageAgent.disposed) {
    window.__tabManagerPageAgent = new window.PageAgent(config);
  }
  window.__tabManagerPageAgent.panel?.show?.();
  return { panelVisible: true };
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
  try {
    await chrome.tabs.sendMessage(resolved.tab.id, {
      type: "page_agent_proxy_enable",
      bridgeId
    });
    await ensurePageAgentRuntime(resolved.tab.id);
    const [result] = await chrome.scripting.executeScript({
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
    });

    return {
      tabId: resolved.tab.id,
      url: resolved.tab.url || "",
      ...(result?.result || { error: "Page Agent returned no result", code: "PAGE_AGENT_EMPTY_RESULT" })
    };
  } catch (error) {
    return {
      error: `Page Agent 无法注入或执行: ${error?.message || String(error)}`,
      code: "PAGE_AGENT_INJECTION_FAILED",
      hint: "该页面可能禁止脚本注入或处于 Chrome 特殊页面。请改用 tab_extract/dom_query/dom_click/dom_set_value/eval_js 等工具。"
    };
  } finally {
    try {
      await chrome.tabs.sendMessage(resolved.tab.id, { type: "page_agent_proxy_disable", bridgeId });
    } catch {
      // The page may have navigated or been closed during Page Agent execution.
    }
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

    window.__tabManagerPageAgent?.dispose?.();
    window.__tabManagerPageAgent = new window.PageAgent({
      ...config,
      customFetch: createProxyFetch()
    });

    const result = await window.__tabManagerPageAgent.execute(instruction);
    return {
      success: result?.success !== false,
      data: result?.data ?? result,
      status: window.__tabManagerPageAgent.status
    };
  } catch (error) {
    return {
      error: error?.message || String(error),
      code: "PAGE_AGENT_PAGE_ERROR",
      hint: "Page Agent 在页面内执行失败。请检查页面是否支持脚本注入，或改用 tab_extract/dom_* 工具。"
    };
  }
}
