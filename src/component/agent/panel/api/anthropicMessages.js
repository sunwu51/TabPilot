
import { buildPlainApiMessage, shouldOmitThinkingFromRequests } from "./_helpers";
import { buildAnthropicToolResultContentFromMessage } from "../messages/toolResults";

export function buildAnthropicAssistantContentFromMessage(msg, options = {}) {
  const omitThinking = shouldOmitThinkingFromRequests(options);

  if (Array.isArray(msg.content)) {
    const contentBlocks = omitThinking ? msg.content.filter(block => !isAnthropicThinkingBlock(block)) : msg.content;
    const hasThinkingBlocks = contentBlocks.some(isAnthropicThinkingBlock);
    const prependedThinkingBlocks = omitThinking || hasThinkingBlocks ? [] : extractAnthropicThinkingBlocksFromMessage(msg);
    return normalizeAnthropicAssistantContentBlocks([...prependedThinkingBlocks, ...contentBlocks]);
  }

  const blocks = omitThinking ? [] : extractAnthropicThinkingBlocksFromMessage(msg);
  if (msg.content && typeof msg.content === "string" && msg.content.length > 0) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name || tc.name;
      let input = tc.function?.arguments ?? tc.arguments ?? tc.args ?? {};
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch (e) { input = { raw: input }; }
      }
      if (toolName) {
        blocks.push({
          type: "tool_use",
          id: tc.id || `tooluse_${toolName}_${Date.now()}`,
          name: toolName,
          input
        });
      }
    }
  }

  return normalizeAnthropicAssistantContentBlocks(blocks);
}

export function normalizeAnthropicAssistantContentBlocks(blocks) {
  return (blocks || []).map(normalizeAnthropicAssistantContentBlock).filter(Boolean);
}

export function normalizeAnthropicAssistantContentBlock(block) {
  if (!block || typeof block !== "object") return null;

  if (block.type === "text") {
    return typeof block.text === "string" && block.text.length > 0 ? { ...block } : null;
  }

  if (block.type === "tool_use") {
    if (!block.name) return null;
    return {
      ...block,
      input: normalizeAnthropicToolUseInput(block.input)
    };
  }

  if (block.type === "thinking") {
    const signature = typeof block.signature === "string" ? block.signature : "";
    if (!signature) return null;
    return {
      ...block,
      thinking: typeof block.thinking === "string" ? block.thinking : ""
    };
  }

  if (block.type === "redacted_thinking") {
    return block.data ? { ...block } : null;
  }

  return { ...block };
}

export function normalizeAnthropicToolUseInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch (error) { return { raw: input }; }
  }
  return input ?? {};
}

export function extractAnthropicThinkingBlocksFromMessage(msg) {
  const blocks = [];

  if (Array.isArray(msg?.thinking_blocks)) {
    blocks.push(...msg.thinking_blocks);
  }

  const providerReasoningBlocks = msg?.provider_specific_fields?.reasoningContentBlocks;
  if (Array.isArray(providerReasoningBlocks)) {
    for (const block of providerReasoningBlocks) {
      const reasoningText = block?.reasoningText;
      if (reasoningText?.signature) {
        blocks.push({
          type: "thinking",
          thinking: reasoningText.text || reasoningText.thinking || "",
          signature: reasoningText.signature
        });
        continue;
      }

      const redacted = block?.redactedContent || block?.redactedThinking || block?.redacted_thinking;
      if (redacted?.data) {
        blocks.push({ type: "redacted_thinking", data: redacted.data });
      }
    }
  }

  return normalizeAnthropicAssistantContentBlocks(blocks).filter(isAnthropicThinkingBlock);
}

export function isAnthropicThinkingBlock(block) {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}
export function buildAnthropicApiMessages(messages, options = {}) {
  const apiMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "error") continue;

    if (msg.role === "tool") {
      const blocks = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        const toolMsg = messages[i];
        blocks.push({
          type: "tool_result",
          tool_use_id: toolMsg.tool_call_id,
          content: buildAnthropicToolResultContentFromMessage(toolMsg, options)
        });
        i += 1;
      }
      i -= 1;
      if (blocks.length > 0) {
        apiMessages.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const content = buildAnthropicAssistantContentFromMessage(msg, options);
      if (content.length === 0) continue;
      apiMessages.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      const anthropicContent = msg.content
        .filter(block => !(block.type === "image" && options.supportsImageInput === false))
        .map(block => {
          if (block.type === "file") {
            const result = { type: "text", text: `[Attached file: ${block.fileName}]\n${block.text}` };
            console.log(`[DEBUG] Anthropic API - 文件转换: ${block.fileName}, 原始长度: ${block.text.length}, 转换后长度: ${result.text.length}`);
            return result;
          }
          return block;
        });
      apiMessages.push({ role: "user", content: anthropicContent });
      continue;
    }

    apiMessages.push(buildPlainApiMessage(msg, options));
  }

  return apiMessages;
}
