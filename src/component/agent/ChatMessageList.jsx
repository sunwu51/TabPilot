import { memo, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import ChatMessage, { EditableChatImage } from "./ChatMessage";

hljs.registerLanguage("javascript", javascript);

const HIDDEN_TOOL_CARD_NAMES = new Set(["plan_create_for_session", "plan_update_for_session", "request_user_input"]);

/* eslint-disable react/prop-types */
const ChatMessageList = memo(function ChatMessageList({
  sessionId = "",
  messages = [],
  onRewindToUserMessage,
  searchState,
  contextSummary,
  contextCompaction,
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver,
  imageRefNavigator
}) {
  const dividerState = buildContextDividerState(contextSummary, contextCompaction, messages.length);
  const groups = useMemo(() => groupMessages(messages, dividerState.index), [messages, dividerState.index]);
  const dividerGroupIndex = findDividerGroupIndex(groups, dividerState.index);

  return (
    <>
      {groups.map((group, groupIndex) => {
        const divider = groupIndex === dividerGroupIndex
          ? <ContextCompressedDivider key={`context-compressed-${dividerState.index}-${dividerState.status}`} status={dividerState.status} />
          : null;
        if (group.type === "tools") {
          return (
            <FragmentWithDivider key={group.key || `tools-${groupIndex}`} divider={divider}>
              <CollapsedToolGroup
                items={group.items}
                toolCallCount={group.toolCallCount}
                onRewindToUserMessage={onRewindToUserMessage}
                sessionId={sessionId}
                imageEditingEnabled={imageEditingEnabled}
                onImageEditRequest={onImageEditRequest}
                imageSrcResolver={imageSrcResolver}
                imageRefNavigator={imageRefNavigator}
              />
            </FragmentWithDivider>
          );
        }
        if (group.type === "tool-sequence") {
          return (
            <FragmentWithDivider key={group.key || `tool-sequence-${groupIndex}`} divider={divider}>
              <ToolMessageSequence
                items={group.items}
                onRewindToUserMessage={onRewindToUserMessage}
                sessionId={sessionId}
                imageEditingEnabled={imageEditingEnabled}
                onImageEditRequest={onImageEditRequest}
                imageSrcResolver={imageSrcResolver}
                imageRefNavigator={imageRefNavigator}
              />
            </FragmentWithDivider>
          );
        }
        return (
          <FragmentWithDivider key={group.key || `msg-${group.index}`} divider={divider}>
            <ChatMessage
              msg={group.message}
              messageIndex={group.index}
              onRewindToUserMessage={onRewindToUserMessage}
              sessionId={sessionId}
              searchState={searchState}
              imageEditingEnabled={imageEditingEnabled}
              onImageEditRequest={onImageEditRequest}
              imageSrcResolver={imageSrcResolver}
              imageRefNavigator={imageRefNavigator}
            />
          </FragmentWithDivider>
        );
      })}
    </>
  );
}, (prevProps, nextProps) =>
  prevProps.messages === nextProps.messages &&
  prevProps.sessionId === nextProps.sessionId &&
  prevProps.searchState === nextProps.searchState &&
  prevProps.contextSummary === nextProps.contextSummary &&
  prevProps.contextCompaction === nextProps.contextCompaction &&
  prevProps.imageEditingEnabled === nextProps.imageEditingEnabled &&
  prevProps.imageSrcResolver === nextProps.imageSrcResolver &&
  prevProps.imageRefNavigator === nextProps.imageRefNavigator
);

export default ChatMessageList;

/* eslint-disable react/prop-types */
function FragmentWithDivider({ children, divider }) {
  return (
    <>
      {children}
      {divider}
    </>
  );
}

function ContextCompressedDivider({ status }) {
  const isCompressing = status === "compressing";
  return (
    <div className="context-compressed-divider" title={isCompressing ? "正在生成摘要，后续请求将使用摘要代替以上历史" : "后续请求将使用摘要代替以上历史"}>
      <span className="context-compressed-line" />
      <span className="context-compressed-text">{isCompressing ? "正在压缩会话内容" : "以上消息已经被压缩"}</span>
      <span className="context-compressed-line" />
    </div>
  );
}

function buildContextDividerState(contextSummary, contextCompaction, messageCount) {
  const compactionIndex = normalizeDividerMessageIndex(contextCompaction, messageCount);
  if (contextCompaction?.status === "compressing" && compactionIndex >= 0) {
    return { index: compactionIndex, status: "compressing" };
  }
  const summaryIndex = normalizeDividerMessageIndex(contextSummary, messageCount);
  return { index: summaryIndex, status: summaryIndex >= 0 ? "compressed" : "" };
}

function normalizeDividerMessageIndex(contextSummary, messageCount) {
  const preferredIndex = Number(contextSummary?.displayMessageIndex);
  const fallbackIndex = Number(contextSummary?.coveredMessageIndex);
  const index = Number.isFinite(preferredIndex) ? preferredIndex : fallbackIndex;
  if (!Number.isFinite(index) || index < 0 || index >= messageCount) return -1;
  return Math.floor(index);
}

function findDividerGroupIndex(groups, dividerIndex) {
  if (!Array.isArray(groups) || groups.length === 0 || dividerIndex < 0) return -1;
  const index = groups.findIndex(group => Number(group?.endIndex) >= dividerIndex);
  return index >= 0 ? index : groups.length - 1;
}

/* eslint-disable react/prop-types */
function CollapsedToolGroup({
  items,
  toolCallCount,
  onRewindToUserMessage,
  sessionId = "",
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver,
  imageRefNavigator
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
            imageRefNavigator={imageRefNavigator}
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
  imageSrcResolver,
  imageRefNavigator
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
              imageRefNavigator={imageRefNavigator}
            />
          );
        }
        return <MergedToolCallBlock key={item.key || `tool-${index}`} item={item} sessionId={sessionId} imageRefNavigator={imageRefNavigator} />;
      })}
    </>
  );
}

/* eslint-disable react/prop-types */
function MergedToolCallBlock({ item, sessionId = "", imageRefNavigator }) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = () => setExpanded(value => !value);
  const result = summarizeToolResultMessage(item.resultMessage);
  const hasResult = !!item.resultMessage && !item.resultMessage._pending;
  const isError = result.isError;
  const name = item.name || result.toolName || "tool";
  const isExec = name === "exec";
  const isSubagent = name === "create_subagent";
  const codeToolCalls = item.resultMessage?._codeToolCalls || [];
  const subagentRuns = item.resultMessage?._subagentRuns || [];
  const inputDetail = isExec ? "" : formatToolInputDetail(item.input);
  const inputDisplay = formatToolDisplayValue(item.input);
  const label = isExec
    ? formatExecToolLabel(codeToolCalls)
    : isSubagent
      ? formatSubagentLabel(subagentRuns)
      : `${name}${inputDetail ? `(${inputDetail})` : ""}`;
  const durationMs = item.resultMessage?.durationMs;
  const durationSuffix = typeof durationMs === "number" ? `${durationMs}ms ` : "";
  const icon = hasResult ? (isError ? "❌" : "✅") : "⏳";
  const pendingHint = !hasResult
    ? (isSubagent ? "子agent执行中..." : (isImageToolName(name) ? "图片生成中..." : ""))
    : "";

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
        <span className="tool-result-label">{icon} <span className="tool-duration">{durationSuffix}</span>{label}</span>
      </div>
      {pendingHint && <div className="tool-result-pending-hint loading-dots">{pendingHint}</div>}
      {expanded && result.displayImageUrl && (
        <div className="tool-result-content" style={{ paddingTop: "8px", paddingBottom: "8px" }}>
          <EditableChatImage
            src={result.displayImageUrl}
            alt={name || "tool screenshot"}
            refId={result.displayImageRef || ""}
            sessionId={sessionId}
            imageRefNavigator={imageRefNavigator}
            wrapperClassName="chat-tool-image-wrap"
            imageClassName="chat-tool-image"
          />
        </div>
      )}
      {expanded && (
        <>
          <div className="tool-merged-section-label">调用参数</div>
          {isExec
            ? <HighlightedExecCode code={item.input?.code} />
            : <pre className={buildToolContentClassName(inputDisplay.isJson)}>{inputDisplay.text}</pre>}
          {isSubagent && subagentRuns.length > 0 && (
            <>
              <div className="tool-merged-section-label">子 agent 执行记录</div>
              <div className="subagent-runs">
                {subagentRuns.map((run, index) => (
                  <div key={run?.id || `subagent-run-${index}`} className={`subagent-run subagent-run-${run?.status || "running"}`}>
                    <span className="subagent-run-status">{run?.status === "error" ? "❌" : run?.status === "running" ? "⏳" : "✅"}</span>
                    <span className="subagent-run-title">{run?.title || run?.name || "tool"}</span>
                    {run?.summary ? <span className="subagent-run-summary">{run.summary}</span> : null}
                  </div>
                ))}
              </div>
            </>
          )}
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

function groupMessages(messages, dividerIndex = -1) {
  const result = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!isToolLikeMessage(message)) {
      result.push({ type: "message", message, index, endIndex: index, key: `msg-${index}` });
      index += 1;
      continue;
    }

    const start = index;
    const group = [];
    while (index < messages.length && isToolLikeMessage(messages[index])) {
      group.push(messages[index]);
      index += 1;
      if (index - 1 === dividerIndex && !isToolResultForPreviousAssistant(messages, index)) break;
    }

    const items = buildToolSequenceItems(group, start);
    if (items.length === 0) continue;

    const toolCallCount = items.filter(item => item.type === "tool").length;
    if (toolCallCount > 5) {
      const splitAtDivider = index - 1 === dividerIndex && isToolLikeMessage(messages[index]);
      const trailingThinking = splitAtDivider ? null : splitTrailingThinkingMessage(messages[index], index);
      if (trailingThinking) {
        items.push(...trailingThinking.items);
        index += 1;
      }

      result.push({
        type: "tools",
        items,
        toolCallCount,
        endIndex: trailingThinking?.remainingMessage ? trailingThinking.messageIndex - 1 : index - 1,
        key: `tools-${start}`
      });
      if (trailingThinking?.remainingMessage) {
        result.push({
          type: "message",
          message: trailingThinking.remainingMessage,
          index: trailingThinking.messageIndex,
          endIndex: trailingThinking.messageIndex,
          key: `msg-${trailingThinking.messageIndex}-without-thinking`
        });
      }
    } else {
      result.push({
        type: "tool-sequence",
        items,
        endIndex: index - 1,
        key: `tool-sequence-${start}`
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
  if (input.tabId) return `Tab ${formatToolInputValue(input.tabId)}`;
  if (input.tabIds) return `${Array.isArray(input.tabIds) ? input.tabIds.length : formatToolInputValue(input.tabIds)} tabs`;
  if (input.url) return formatToolInputValue(input.url);
  if (input.query) return formatToolInputValue(input.query);
  return formatToolInputValue(input);
}

function formatToolInputValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
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
      label = formatToolResultLabel(parsed.error);
    } else if (parsed.title) {
      label = formatToolResultLabel(parsed.title);
    } else if (parsed.success) {
      label = formatToolResultLabel(parsed.url || parsed.name || "success");
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

function formatToolResultLabel(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.message === "string") return value.message;
  return formatToolInputValue(value);
}

function HighlightedExecCode({ code }) {
  const source = typeof code === "string" ? code : "";
  const highlighted = useMemo(() => hljs.highlight(source, { language: "javascript" }).value, [source]);
  return (
    <pre className="tool-result-content tool-exec-code-content">
      <code className="hljs language-javascript" dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  );
}

function formatSubagentLabel(runs) {
  const prefix = "创建子agent";
  if (!Array.isArray(runs) || runs.length === 0) return prefix;
  const completed = runs.filter(run => run?.status === "completed").length;
  return `${prefix} · ${completed}/${runs.length} 步`;
}

function formatExecToolLabel(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "exec";
  return toolCalls.map(call => formatNestedToolCall(call)).join(" ");
}

function formatNestedToolCall(call) {
  const name = String(call?.name || "tool");
  const args = call?.args;
  const rawDetail = args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0
    ? ""
    : formatToolInputDetail(args);
  const detail = rawDetail.length > 120 ? `${rawDetail.slice(0, 117)}...` : rawDetail;
  return `${name}(${detail})`;
}

function isToolResultForPreviousAssistant(messages, index) {
  const current = messages[index];
  const previous = messages[index - 1];
  if (current?.role !== "tool") return false;
  return messageHasToolCallId(previous, current.tool_call_id);
}

function messageHasToolCallId(message, toolCallId) {
  if (!message || message.role !== "assistant" || !toolCallId) return false;
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.some(call => (call?.id || call?.tool_call_id) === toolCallId);
  }
  if (Array.isArray(message.content)) {
    return message.content.some(block => block?.type === "tool_use" && block.id === toolCallId);
  }
  return false;
}

function isHiddenToolCardName(name) {
  return HIDDEN_TOOL_CARD_NAMES.has(String(name || ""));
}
