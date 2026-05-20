import { resolveLlmRequestUrl } from "../core/endpoint";
import { DEFAULT_ANTHROPIC_CACHE_CONTROL } from "../core/constants";
import { API_TYPES } from "../core/config";
import { buildFirstPacketTimeoutError, createFirstPacketTimeoutState, createLlmStreamError, getFirstPacketTimeoutMs, isAbortError, mergeUsage } from "../core/shared";
import { getTools } from "../tools/definitions";
import { isLongToolArgumentName } from "../core/longToolArgs";
import { buildAnthropicReasoningFields } from "../core/reasoning";

// ==================== Anthropic Messages API ====================

export async function streamAnthropicAttempt(config, messages, signal, { onText, onThinking, onDone, onToolArgsDelta, onToolArgsDone }, mcpTools = [], options = {}) {
  const tools = getTools(API_TYPES.ANTHROPIC, mcpTools, options);
  const timeoutState = createFirstPacketTimeoutState(signal, getFirstPacketTimeoutMs(config));

  try {
    let systemPrompt = "";
    const apiMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") systemPrompt = msg.content;
      else apiMessages.push(msg);
    }

    const url = resolveLlmRequestUrl(API_TYPES.ANTHROPIC, config.baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: config.model,
        cache_control: DEFAULT_ANTHROPIC_CACHE_CONTROL,
        system: systemPrompt,
        messages: apiMessages,
        tools, max_tokens: 4096, stream: true,
        ...buildAnthropicReasoningFields(config)
      }),
      signal: timeoutState.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw createLlmStreamError({
        code: `HTTP_${res.status}`,
        message: `LLM 接口返回 HTTP ${res.status}`,
        status: res.status,
        detail: errText || `HTTP ${res.status}`
      });
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw createLlmStreamError({
        code: "EMPTY_RESPONSE_BODY",
        message: "LLM 未返回响应流"
      });
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    let collectedToolUses = [];
    const activeContentBlocks = new Map();
    const rawContentBlocks = [];
    let buffer = "";
    let sawToolUseBlock = false;
    let usage = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        timeoutState.markFirstPacketReceived();
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);

        try {
          const json = JSON.parse(data);
          usage = mergeAnthropicUsage(usage, extractAnthropicStreamUsage(json));

          if (json.type === "content_block_start") {
            const index = getAnthropicEventIndex(json);
            const block = normalizeAnthropicContentBlockStart(json.content_block);
            if (block) {
              activeContentBlocks.set(index, block);
              if (block.type === "tool_use") sawToolUseBlock = true;
              if (block.type === "text" && block.text) {
                fullContent += block.text;
                onText?.(block.text);
              } else if (block.type === "thinking" && block.thinking) {
                onThinking?.(block.thinking, { field: "thinking", provider: API_TYPES.ANTHROPIC });
              }
            }
          } else if (json.type === "content_block_delta") {
            const index = getAnthropicEventIndex(json);
            const block = activeContentBlocks.get(index);
            if (json.delta?.type === "text_delta") {
              const text = json.delta.text || "";
              fullContent += text;
              if (block?.type === "text") block.text += text;
              onText?.(text);
            } else if (json.delta?.type === "input_json_delta" && block?.type === "tool_use") {
              const delta = json.delta.partial_json || "";
              block.inputJson += delta;
              if (delta && isLongToolArgumentName(block.name)) {
                onToolArgsDelta?.({
                  id: block.id || `tooluse_${index}`,
                  index,
                  name: block.name,
                  delta,
                  arguments: block.inputJson
                });
              }
            } else if (json.delta?.type === "thinking_delta" && block?.type === "thinking") {
              const thinking = json.delta.thinking || "";
              block.thinking += thinking;
              if (thinking) {
                onThinking?.(thinking, { field: "thinking", provider: API_TYPES.ANTHROPIC });
              }
            } else if (json.delta?.type === "signature_delta" && block?.type === "thinking") {
              block.signature = (block.signature || "") + (json.delta.signature || "");
            }
          } else if (json.type === "content_block_stop") {
            const index = getAnthropicEventIndex(json);
            const block = activeContentBlocks.get(index);
            if (block) {
              if (block.type === "tool_use") collectedToolUses.push(block);
              if (block.type === "tool_use" && isLongToolArgumentName(block.name)) {
                onToolArgsDone?.({
                  id: block.id || `tooluse_${index}`,
                  index,
                  name: block.name,
                  arguments: block.inputJson
                });
              }
              rawContentBlocks.push(block);
              activeContentBlocks.delete(index);
            }
          }
        } catch (error) {
          throw createLlmStreamError({
            code: "STREAM_PARSE_ERROR",
            message: "解析 Anthropic 流式响应失败",
            detail: error?.message || String(error)
          });
        }
      }
    }


    const parseFailures = [];
    const parsedToolUsesByBlock = new Map();
    const toolCalls = collectedToolUses
      .map((tu, index) => {
        try {
          const id = tu.id || `tooluse_${index}_${Date.now()}`;
          const input = JSON.parse(tu.inputJson || "{}");
          parsedToolUsesByBlock.set(tu, { id, name: tu.name, input });
          return {
            id,
            name: tu.name,
            args: input
          };
        } catch (error) {
          parseFailures.push({ name: tu.name, inputJson: tu.inputJson, error: error.message });
          return null;
        }
      })
      .filter(Boolean);

    if (parseFailures.length > 0) {
      throw createLlmStreamError({
        code: "TOOL_CALL_PARSE_ERROR",
        message: "工具调用参数解析失败",
        detail: parseFailures
      });
    }

    if (sawToolUseBlock && toolCalls.length === 0 && !fullContent) {
      throw createLlmStreamError({
        code: "EMPTY_TOOL_CALL_STREAM",
        message: "模型返回了工具调用片段，但未能重建有效工具调用"
      });
    }

    const contentBlocks = rawContentBlocks
      .map(block => buildAnthropicContentBlock(block, parsedToolUsesByBlock))
      .filter(Boolean);
    if (fullContent && !contentBlocks.some(block => block.type === "text")) {
      contentBlocks.push({ type: "text", text: fullContent });
    }
    const thinkingBlocks = contentBlocks.filter(isAnthropicThinkingContentBlock);

    onDone?.({
      role: "assistant",
      content: contentBlocks.length > 0 ? contentBlocks : null,
      ...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });
  } catch (error) {
    if (timeoutState.didTimeout && !signal.aborted) {
      throw buildFirstPacketTimeoutError(config);
    }
    if (isAbortError(error) && signal.aborted) {
      throw error;
    }
    throw error;
  } finally {
    timeoutState.cleanup();
  }
}

function getAnthropicEventIndex(event) {
  return Number.isInteger(event?.index) ? event.index : 0;
}

function normalizeAnthropicContentBlockStart(contentBlock) {
  if (!contentBlock || typeof contentBlock !== "object") return null;

  if (contentBlock.type === "text") {
    return { type: "text", text: contentBlock.text || "" };
  }

  if (contentBlock.type === "tool_use") {
    return {
      type: "tool_use",
      id: contentBlock.id,
      name: contentBlock.name,
      inputJson: ""
    };
  }

  if (contentBlock.type === "thinking") {
    return {
      type: "thinking",
      thinking: contentBlock.thinking || "",
      ...(contentBlock.signature ? { signature: contentBlock.signature } : {})
    };
  }

  if (contentBlock.type === "redacted_thinking") {
    return {
      type: "redacted_thinking",
      data: contentBlock.data || ""
    };
  }

  return { ...contentBlock };
}

function buildAnthropicContentBlock(block, parsedToolUsesByBlock) {
  if (!block || typeof block !== "object") return null;

  if (block.type === "text") {
    return block.text ? { type: "text", text: block.text } : null;
  }

  if (block.type === "tool_use") {
    const parsed = parsedToolUsesByBlock.get(block);
    if (!parsed?.name) return null;
    return {
      type: "tool_use",
      id: parsed.id,
      name: parsed.name,
      input: parsed.input
    };
  }

  if (block.type === "thinking") {
    const thinking = block.thinking || "";
    const signature = block.signature || "";
    if (!thinking && !signature) return null;
    return {
      type: "thinking",
      thinking,
      ...(signature ? { signature } : {})
    };
  }

  if (block.type === "redacted_thinking") {
    return block.data ? { type: "redacted_thinking", data: block.data } : null;
  }

  return block;
}

function isAnthropicThinkingContentBlock(block) {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

function extractAnthropicStreamUsage(event) {
  if (!event || typeof event !== "object") return null;
  if (event.usage && typeof event.usage === "object") return event.usage;
  if (event.message?.usage && typeof event.message.usage === "object") return event.message.usage;
  return null;
}

function mergeAnthropicUsage(current = {}, next) {
  return mergeUsage(current, next);
}
