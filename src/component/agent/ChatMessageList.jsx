import { memo, useMemo, useState } from "react";
import ChatMessage from "./ChatMessage";

const HIDDEN_TOOL_CARD_NAMES = new Set(["plan_create_for_session", "plan_update_for_session"]);

/* eslint-disable react/prop-types */
const ChatMessageList = memo(function ChatMessageList({
  sessionId = "",
  messages = [],
  onRewindToUserMessage,
  searchState,
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver
}) {
  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <>
      {groups.map((group, groupIndex) => {
        if (group.type === "tools") {
          return (
            <CollapsedToolGroup
              key={group.key || `tools-${groupIndex}`}
              items={group.items}
              toolCallCount={group.toolCallCount}
              onRewindToUserMessage={onRewindToUserMessage}
              sessionId={sessionId}
              imageEditingEnabled={imageEditingEnabled}
              onImageEditRequest={onImageEditRequest}
              imageSrcResolver={imageSrcResolver}
            />
          );
        }
        if (group.type === "tool-sequence") {
          return (
            <ToolMessageSequence
              key={group.key || `tool-sequence-${groupIndex}`}
              items={group.items}
              onRewindToUserMessage={onRewindToUserMessage}
              sessionId={sessionId}
              imageEditingEnabled={imageEditingEnabled}
              onImageEditRequest={onImageEditRequest}
              imageSrcResolver={imageSrcResolver}
            />
          );
        }
        return (
          <ChatMessage
            key={group.key || `msg-${group.index}`}
            msg={group.message}
            messageIndex={group.index}
            onRewindToUserMessage={onRewindToUserMessage}
            sessionId={sessionId}
            searchState={searchState}
            imageEditingEnabled={imageEditingEnabled}
            onImageEditRequest={onImageEditRequest}
            imageSrcResolver={imageSrcResolver}
          />
        );
      })}
    </>
  );
}, (prevProps, nextProps) =>
  prevProps.messages === nextProps.messages &&
  prevProps.sessionId === nextProps.sessionId &&
  prevProps.searchState === nextProps.searchState &&
  prevProps.imageEditingEnabled === nextProps.imageEditingEnabled
);

export default ChatMessageList;

/* eslint-disable react/prop-types */
function CollapsedToolGroup({
  items,
  toolCallCount,
  onRewindToUserMessage,
  sessionId = "",
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = () => setExpanded(value => !value);

  return (
    <div className="tool-result-msg tool-group-msg">
      <div
        className="tool-result-header"
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(event) => handleToggleKeyDown(event, toggleExpanded)}
      >
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">展开查看 {toolCallCount} 个工具调用详情</span>
      </div>
      {expanded && (
        <div className="tool-group-content">
          <ToolMessageSequence
            items={items}
            onRewindToUserMessage={onRewindToUserMessage}
            sessionId={sessionId}
            imageEditingEnabled={imageEditingEnabled}
            onImageEditRequest={onImageEditRequest}
            imageSrcResolver={imageSrcResolver}
          />
        </div>
      )}
    </div>
  );
}

/* eslint-disable react/prop-types */
function ToolMessageSequence({
  items,
  onRewindToUserMessage,
  sessionId = "",
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver
}) {
  return (
    <>
      {items.map((item, index) => {
        if (item.type === "message") {
          return (
            <ChatMessage
              key={item.key || `msg-${index}`}
              msg={item.message}
              messageIndex={item.messageIndex}
              onRewindToUserMessage={onRewindToUserMessage}
              sessionId={sessionId}
              imageEditingEnabled={imageEditingEnabled}
              onImageEditRequest={onImageEditRequest}
              imageSrcResolver={imageSrcResolver}
            />
          );
        }
        return <MergedToolCallBlock key={item.key || `tool-${index}`} item={item} />;
      })}
    </>
  );
}

/* eslint-disable react/prop-types */
function MergedToolCallBlock({ item }) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = () => setExpanded(value => !value);
  const result = summarizeToolResultMessage(item.resultMessage);
  const hasResult = !!item.resultMessage && !item.resultMessage._pending;
  const isError = result.isError;
  const name = item.name || result.toolName || "tool";
  const inputDetail = formatToolInputDetail(item.input);
  const inputDisplay = formatToolDisplayValue(item.input);
  const label = `${name}${inputDetail ? `(${inputDetail})` : ""}`;
  const suffix = hasResult && result.label ? ` · ${result.label}` : "";
  const durationMs = item.resultMessage?.durationMs;
  const durationSuffix = typeof durationMs === "number" ? `${durationMs}ms ` : "";
  const icon = hasResult ? (isError ? "❌" : "✅") : "⏳";
  const pendingHint = !hasResult && isImageToolName(name) ? "图片生成中..." : "";

  return (
    <div className={`tool-result-msg ${isError ? "tool-result-error" : ""}`}>
      <div
        className="tool-result-header"
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(event) => handleToggleKeyDown(event, toggleExpanded)}
      >
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">{icon} <span className="tool-duration">{durationSuffix}</span>{label}{suffix}</span>
      </div>
      {pendingHint && <div className="tool-result-pending-hint loading-dots">{pendingHint}</div>}
      {expanded && result.displayImageUrl && (
        <div className="tool-result-content" style={{ paddingTop: "8px", paddingBottom: "8px" }}>
          <img
            src={result.displayImageUrl}
            alt={name || "tool screenshot"}
            style={{
              display: "block",
              maxWidth: "100%",
              width: "100%",
              maxHeight: "420px",
              objectFit: "contain",
              borderRadius: "8px",
              background: "#f5f5f5"
            }}
          />
        </div>
      )}
      {expanded && (
        <>
          <div className="tool-merged-section-label">调用参数</div>
          <pre className={buildToolContentClassName(inputDisplay.isJson)}>{inputDisplay.text}</pre>
          {hasResult && (
            <>
              <div className="tool-merged-section-label">执行结果</div>
              <pre className={buildToolContentClassName(result.isJson)}>{result.displayContent}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

function handleToggleKeyDown(event, toggleExpanded) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleExpanded();
}

function groupMessages(messages) {
  const result = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!isToolLikeMessage(message)) {
      result.push({ type: "message", message, index, key: `msg-${index}` });
      index += 1;
      continue;
    }

    const start = index;
    const group = [];
    while (index < messages.length && isToolLikeMessage(messages[index])) {
      group.push(messages[index]);
      index += 1;
    }

    const items = buildToolSequenceItems(group, start);
    if (items.length === 0) continue;

    const toolCallCount = items.filter(item => item.type === "tool").length;
    if (toolCallCount > 5) {
      const trailingThinking = splitTrailingThinkingMessage(messages[index], index);
      if (trailingThinking) {
        items.push(...trailingThinking.items);
        index += 1;
      }

      result.push({
        type: "tools",
        items,
        toolCallCount,
        key: `tools-${start}-${group.length}-${toolCallCount}-${trailingThinking?.items.length || 0}`
      });
      if (trailingThinking?.remainingMessage) {
        result.push({
          type: "message",
          message: trailingThinking.remainingMessage,
          index: trailingThinking.messageIndex,
          key: `msg-${trailingThinking.messageIndex}-without-thinking`
        });
      }
    } else {
      result.push({
        type: "tool-sequence",
        items,
        key: `tool-sequence-${start}-${group.length}-${toolCallCount}`
      });
    }
  }

  return result;
}

function splitTrailingThinkingMessage(message, messageIndex) {
  if (!message || message.role !== "assistant" || isToolLikeMessage(message)) return null;

  const thinkingBlocks = extractThinkingBlocksFromAssistantMessage(message);
  if (thinkingBlocks.length === 0) return null;

  const remainingMessage = stripThinkingFromAssistantMessage(message);
  return {
    messageIndex,
    items: thinkingBlocks.map((block, index) => ({
      type: "message",
      message: { role: "assistant", content: [block] },
      messageIndex,
      key: `msg-${messageIndex}-trailing-thinking-${index}`
    })),
    remainingMessage: hasRenderableAssistantMessage(remainingMessage) ? remainingMessage : null
  };
}

function extractThinkingBlocksFromAssistantMessage(message) {
  if (Array.isArray(message?.content)) {
    const contentBlocks = message.content.filter(block => block?.type === "thinking" || block?.type === "redacted_thinking");
    if (contentBlocks.length > 0) return contentBlocks;
  }
  return extractThinkingBlocksForRender(message);
}

function stripThinkingFromAssistantMessage(message) {
  const next = { ...message };
  delete next.thinking_blocks;
  delete next.provider_specific_fields;
  delete next.reasoning_content;
  delete next.reasoning;
  delete next.reasoning_details;
  delete next.thinking;

  if (Array.isArray(message.content)) {
    next.content = message.content.filter(block => block?.type !== "thinking" && block?.type !== "redacted_thinking");
  }
  return next;
}

function hasRenderableAssistantMessage(message) {
  if (!message || message.role !== "assistant") return false;
  if (typeof message.content === "string") return message.content.length > 0;
  if (Array.isArray(message.content)) {
    return message.content.some(block => {
      if (!block) return false;
      if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
      return block.type !== "thinking" && block.type !== "redacted_thinking";
    });
  }
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function buildToolSequenceItems(messages, startIndex) {
  const items = [];
  const toolItemsById = new Map();
  const anonymousToolItems = [];

  for (let offset = 0; offset < messages.length; offset++) {
    const message = messages[offset];
    const messageIndex = startIndex + offset;
    if (!message) continue;

    if (message.role === "assistant") {
      for (const renderItem of extractAssistantRenderItems(message)) {
        if (renderItem.type === "message") {
          items.push({
            type: "message",
            message: renderItem.message,
            messageIndex,
            key: `msg-${messageIndex}-${items.length}`
          });
          continue;
        }

        if (isHiddenToolCardName(renderItem.name)) {
          continue;
        }

        const toolItem = {
          type: "tool",
          id: renderItem.id || "",
          name: renderItem.name,
          input: renderItem.input,
          resultMessage: null,
          resultIndex: null,
          key: `tool-${renderItem.id || `${messageIndex}-${items.length}`}`
        };
        items.push(toolItem);
        if (toolItem.id) toolItemsById.set(toolItem.id, toolItem);
        else anonymousToolItems.push(toolItem);
      }
      continue;
    }

    if (message.role === "tool") {
      if (isHiddenToolCardName(message.tool_name)) {
        continue;
      }

      const id = message.tool_call_id;
      let toolItem = id ? toolItemsById.get(id) : anonymousToolItems.find(item => !item.resultMessage);
      if (!toolItem) {
        toolItem = {
          type: "tool",
          id: id || "",
          name: message.tool_name || "tool",
          input: undefined,
          resultMessage: null,
          resultIndex: null,
          key: `tool-result-${id || messageIndex}`
        };
        items.push(toolItem);
        if (id) toolItemsById.set(id, toolItem);
      }
      if ((!toolItem.name || toolItem.name === "tool") && message.tool_name) {
        toolItem.name = message.tool_name;
      }
      toolItem.resultMessage = message;
      toolItem.resultIndex = messageIndex;
    }
  }

  return items;
}

function extractAssistantRenderItems(message) {
  const items = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block) continue;
      if (block.type === "text" && block.text) {
        items.push({ type: "message", message: { role: "assistant", content: block.text } });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        items.push({ type: "message", message: { role: "assistant", content: [block] } });
      } else if (block.type === "tool_use") {
        if (isHiddenToolCardName(block.name)) continue;
        items.push({
          type: "tool",
          id: block.id || "",
          name: block.name || "tool",
          input: block.input
        });
      }
    }
    return items;
  }

  for (const block of extractThinkingBlocksForRender(message)) {
    items.push({ type: "message", message: { role: "assistant", content: [block] } });
  }

  if (message.content && typeof message.content === "string") {
    items.push({ type: "message", message: { role: "assistant", content: message.content } });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall?.function?.name || toolCall?.name || "tool";
      if (isHiddenToolCardName(toolName)) continue;
      items.push(normalizeOpenAIToolCall(toolCall));
    }
  }

  return items;
}

function extractThinkingBlocksForRender(message) {
  const blocks = [];

  if (Array.isArray(message?.thinking_blocks)) {
    blocks.push(...message.thinking_blocks);
  }

  const providerReasoningBlocks = message?.provider_specific_fields?.reasoningContentBlocks;
  if (Array.isArray(providerReasoningBlocks)) {
    for (const block of providerReasoningBlocks) {
      const reasoningText = block?.reasoningText;
      if (reasoningText) {
        blocks.push({
          type: "thinking",
          thinking: reasoningText.text || reasoningText.thinking || "",
          ...(reasoningText.signature ? { signature: reasoningText.signature } : {})
        });
        continue;
      }

      const redacted = block?.redactedContent || block?.redactedThinking || block?.redacted_thinking;
      if (redacted?.data) {
        blocks.push({ type: "redacted_thinking", data: redacted.data });
      }
    }
  }

  if (blocks.length === 0 && typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0) {
    blocks.push({ type: "thinking", thinking: message.reasoning_content });
  }

  if (blocks.length === 0 && typeof message?.reasoning === "string" && message.reasoning.length > 0) {
    blocks.push({ type: "thinking", thinking: message.reasoning });
  }

  if (blocks.length === 0 && typeof message?.thinking === "string" && message.thinking.length > 0) {
    blocks.push({ type: "thinking", thinking: message.thinking });
  }

  if (blocks.length === 0) {
    const reasoningDetailsText = flattenReasoningDetailsForRender(message?.reasoning_details);
    if (reasoningDetailsText) {
      blocks.push({ type: "thinking", thinking: reasoningDetailsText });
    }
  }

  return blocks.filter(block => {
    if (block?.type === "thinking") return typeof block.thinking === "string" || typeof block.signature === "string";
    if (block?.type === "redacted_thinking") return typeof block.data === "string" && block.data.length > 0;
    return false;
  });
}

function flattenReasoningDetailsForRender(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(flattenReasoningDetailsForRender).filter(Boolean).join("\n\n").trim();
  }
  if (value && typeof value === "object") {
    return [
      value.text,
      value.reasoning,
      value.summary,
      value.content,
      value.output_text
    ].map(flattenReasoningDetailsForRender).filter(Boolean).join("\n\n").trim();
  }
  return "";
}

function normalizeOpenAIToolCall(toolCall) {
  const input = toolCall?.function?.arguments ?? toolCall?.arguments ?? toolCall?.args ?? {};
  return {
    type: "tool",
    id: toolCall?.id || toolCall?.tool_call_id || "",
    name: toolCall?.function?.name || toolCall?.name || "tool",
    input: parseToolInput(input)
  };
}

function parseToolInput(input) {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch (_e) {
    return { raw: input };
  }
}

function formatToolInputDetail(input) {
  if (!input || typeof input !== "object") return String(input || "");
  if (input.tabId) return `Tab ${input.tabId}`;
  if (input.tabIds) return `${input.tabIds.length} tabs`;
  if (input.url) return input.url;
  if (input.query) return input.query;
  return JSON.stringify(input);
}

function summarizeToolResultMessage(message) {
  if (!message) {
    return { isError: false, label: "", displayContent: "", displayImageUrl: "", isJson: false };
  }

  const content = message.content;
  const display = formatToolDisplayValue(content);
  const parsed = display.parsedJson || (content && typeof content === "object" ? content : null);
  let label = "tool result";
  let isError = false;

  if (parsed && typeof parsed === "object") {
    if (parsed.error) {
      isError = true;
      label = parsed.error;
    } else if (parsed.title) {
      label = parsed.title;
    } else if (parsed.success) {
      label = parsed.url || parsed.name || "success";
    } else if (parsed.result) {
      label = typeof parsed.result === "string" ? parsed.result.substring(0, 60) : "result";
    }
  }

  if (message.tool_name && label === "success") {
    label = message.tool_name;
  }

  return {
    isError,
    label,
    toolName: message.tool_name || "",
    displayImageUrl: message.displayImageUrl || "",
    displayContent: display.text,
    isJson: display.isJson
  };
}

function buildToolContentClassName(isJson) {
  return `tool-result-content${isJson ? " tool-json-content" : ""}`;
}

function formatToolDisplayValue(value) {
  if (value === undefined) {
    return { text: "", isJson: false, parsedJson: null };
  }

  const parsed = parseStructuredJson(value);
  if (parsed.ok) {
    return {
      text: stringifyToolJson(parsed.value),
      isJson: true,
      parsedJson: parsed.value
    };
  }

  if (typeof value === "string") {
    return { text: value, isJson: false, parsedJson: null };
  }
  return {
    text: stringifyToolJson(value),
    isJson: false,
    parsedJson: null
  };
}

function isImageToolName(name) {
  return name === "image_gen" || name === "image_edit";
}

function parseStructuredJson(value, depth = 0) {
  if (isStructuredJson(value)) {
    return { ok: true, value };
  }

  if (typeof value !== "string") {
    return { ok: false, value: null };
  }

  const trimmed = value.trim();
  if (!looksLikeJsonText(trimmed)) {
    return { ok: false, value: null };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && depth < 2 && looksLikeJsonText(parsed.trim())) {
      return parseStructuredJson(parsed, depth + 1);
    }
    return isStructuredJson(parsed) ? { ok: true, value: parsed } : { ok: false, value: null };
  } catch (_e) {
    return { ok: false, value: null };
  }
}

function isStructuredJson(value) {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

function looksLikeJsonText(value) {
  if (!value) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "{" && last === "}") || (first === "[" && last === "]") || first === "\"";
}

function stringifyToolJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch (_e) {
    return String(value);
  }
}

function isToolLikeMessage(message) {
  if (!message) return false;
  if (message.role === "tool") return true;
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content.some((block) => block?.type === "tool_use");
  }
  return false;
}

function isHiddenToolCardName(name) {
  return HIDDEN_TOOL_CARD_NAMES.has(String(name || ""));
}
