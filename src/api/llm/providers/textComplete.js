/* global chrome */
import { resolveLlmRequestUrl } from "../core/endpoint";
import { API_TYPES, getDefaultApiType, normalizeApiType } from "../core/config";
import { syncActiveModelFields } from "../core/modelProfiles";
import { ensureSettingsMigrated } from "../../settings/migrations";

/**
 * Lightweight non-streaming, no-tools LLM text completion.
 * Shared between the side panel and the service worker.
 *
 * @param {Object} config - { apiType, baseUrl, apiKey, model }
 * @param {Array}  messages - [{ role, content }] — plain text only, no tool messages
 * @returns {Promise<string>} the assistant text response
 */
export async function textComplete(config, messages, options = {}) {
  if (!config?.apiKey || !config?.baseUrl || !config?.model) {
    throw new Error("LLM config incomplete (apiKey / baseUrl / model required)");
  }

  const apiType = normalizeApiType(config.apiType);
  if (apiType === API_TYPES.ANTHROPIC) {
    return _anthropicComplete(config, messages);
  }
  if (apiType === API_TYPES.OPENAI_RESPONSES) {
    return _openaiResponsesComplete(config, messages, options);
  }
  return _openaiComplete(config, messages, options);
}

const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };

function buildOpenAICacheFields(options = {}) {
  const cacheKey = String(options?.sessionId || "").trim();
  return cacheKey ? { prompt_cache_key: cacheKey } : {};
}

async function _openaiComplete(config, messages, options = {}) {
  const url = resolveLlmRequestUrl(API_TYPES.OPENAI_CHAT_COMPLETIONS, config.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      max_tokens: 600,
      enable_thinking: false,
      ...buildOpenAICacheFields(options)
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  const text = extractOpenAITextContent(content);
  if (!text) {
    if (options?.allowEmptyResponse === true) return "";
    throw new Error("Unexpected OpenAI response shape");
  }
  return text;
}

function extractOpenAITextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((block) => extractTextBlockText(block))
      .filter(Boolean)
      .join("")
      .trim();
    return text;
  }

  return "";
}

function extractTextBlockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "reasoning" || block.type === "thinking" || block.type === "redacted_thinking") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.output_text === "string") return block.output_text;
  if (typeof block.value === "string") return block.value;
  return "";
}



async function _openaiResponsesComplete(config, messages, options = {}) {
  const url = resolveLlmRequestUrl(API_TYPES.OPENAI_RESPONSES, config.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: messages.map((msg) => ({
        role: msg.role,
        content: [{ type: "input_text", text: typeof msg.content === "string" ? msg.content : String(msg.content ?? "") }]
      })),
      stream: false,
      max_output_tokens: 600,
      ...buildOpenAICacheFields(options)
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`OpenAI Responses API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const text = extractOpenAIResponsesTextContent(json);
  if (!text) {
    throw new Error("Unexpected OpenAI Responses response shape");
  }
  return text;
}

function extractOpenAIResponsesTextContent(response) {
  const outputs = Array.isArray(response?.output) ? response.output : [];
  const text = outputs
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((block) => (block?.type === "output_text" || block?.type === "text") && typeof block?.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (text) return text;
  if (typeof response?.output_text === "string") return response.output_text.trim();
  return "";
}

async function _anthropicComplete(config, messages) {
  let systemPrompt = "";
  const apiMessages = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else {
      apiMessages.push(msg);
    }
  }

  const url = resolveLlmRequestUrl(API_TYPES.ANTHROPIC, config.baseUrl);
  const body = {
    model: config.model,
    cache_control: DEFAULT_ANTHROPIC_CACHE_CONTROL,
    messages: apiMessages,
    max_tokens: 600,
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const block = json?.content?.find((b) => b.type === "text");
  if (!block?.text) {
    throw new Error("Unexpected Anthropic response shape");
  }
  return block.text.trim();
}

/**
 * Read LLM config from chrome.storage.local.
 * Returns null if not configured.
 */
export async function getLLMConfigForMemory() {
  await ensureSettingsMigrated();
  const { llmConfig } = await chrome.storage.local.get({
    llmConfig: { activeLlmModelId: "", llmModels: [] },
  });
  const activeConfig = syncActiveModelFields(llmConfig);
  if (!activeConfig?.apiKey || !activeConfig?.baseUrl || !activeConfig?.model) {
    return null;
  }
  return activeConfig;
}
