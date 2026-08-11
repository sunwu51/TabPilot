/* global chrome */
import {
  DEFAULT_OPENCODE_ZEN_FREE_LLM_PROFILE,
  resolveActiveLlmConfig
} from "../../core/modelProfiles";
import { API_TYPES } from "../../core/config";
import { _resolveControllableTab } from "./_shared";

const PAGE_AGENT_CDN_URL = "https://cdn.jsdelivr.net/npm/page-agent@1.12.2/dist/iife/page-agent.demo.js?autoInit=false";

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
  const profile = activeConfig.apiType === API_TYPES.OPENAI_CHAT_COMPLETIONS
    ? activeConfig
    : DEFAULT_OPENCODE_ZEN_FREE_LLM_PROFILE;
  const baseUrl = normalizeChatBaseUrl(profile.baseUrl);

  if (!baseUrl || !profile.model) {
    return {
      error: "No usable Chat Completions model is configured for Page Agent",
      code: "PAGE_AGENT_NO_CHAT_MODEL",
      hint: "Use the existing tab_extract/dom_* tools, or configure a Chat Completions model."
    };
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: resolved.tab.id },
      world: "MAIN",
      func: executePageAgentInPage,
      args: [{
        instruction: task,
        cdnUrl: PAGE_AGENT_CDN_URL,
        config: {
          model: profile.model,
          baseURL: baseUrl,
          apiKey: profile.apiKey || "",
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
      hint: "该页面可能禁止脚本注入、处于 Chrome 特殊页面，或 CDN 无法加载。请改用 tab_extract/dom_query/dom_click/dom_set_value/eval_js 等工具。"
    };
  }
}

function normalizeChatBaseUrl(value) {
  return String(value || "").trim().replace(/\/chat\/completions\/?$/i, "");
}

async function executePageAgentInPage({ instruction, cdnUrl, config }) {
  try {
    if (!window.PageAgent) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = cdnUrl;
        script.crossOrigin = "anonymous";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Page Agent CDN 加载失败"));
        (document.head || document.documentElement).appendChild(script);
      });
    }

    if (!window.__tabManagerPageAgent || window.__tabManagerPageAgent.disposed) {
      window.__tabManagerPageAgent = new window.PageAgent(config);
    }

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
