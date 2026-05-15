/* global chrome */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/atom-one-dark.css";
import { Button, Dialog } from "@sunwu51/camel-ui";
import { memo, useEffect, useState } from "react";

/**
 * Render a single chat message based on its role and content.
 * @param {object} props
 * @param {object} props.msg
 * @param {number} [props.messageIndex]
 * @param {(index: number) => void} [props.onRewindToUserMessage]
 */
/* eslint-disable react/prop-types */
const ChatMessage = memo(function ChatMessage({ msg, messageIndex, onRewindToUserMessage, searchState }) {
  const { role, content } = msg;
  const messageSearchState = isSearchableChatMessage(msg)
    ? buildMessageSearchState(searchState, messageIndex)
    : null;
  const searchAnchorProps = messageSearchState
    ? {
        "data-chat-search-message-index": messageIndex
      }
    : {};

  // User message
  if (role === "user") {
    const { sentAt, durationMs } = msg;
    // Skip Anthropic tool_result format
    if (Array.isArray(content) && content.some(block => block.type === "tool_result")) {
      return null;
    }

    const showRewind =
      typeof messageIndex === "number" &&
      typeof onRewindToUserMessage === "function";

    // Multimodal message (text + images)
    if (Array.isArray(content)) {
      return (
        <div className="chat-msg chat-msg-user" {...searchAnchorProps}>
          <div className="chat-msg-user-inner">
            {showRewind && (
              <Dialog
                trigger={
                  <button
                    type="button"
                    className="chat-user-rewind-btn"
                    title="回退到此消息"
                    aria-label="回退到此消息"
                    onClick={(e) => e.stopPropagation()}
                  >
                    ↩
                  </button>
                }
              >
                <div className="text-sm font-semibold text-gray-600 mb-2">回退到此消息</div>
                <div className="text-xs text-gray-500 mb-3">回退到这条消息后，之后的消息会被删除。</div>
                <div className="flex justify-end">
                  <Button
                    className="!text-xs"
                    onPress={() => onRewindToUserMessage(messageIndex)}
                  >
                    确认回退
                  </Button>
                </div>
              </Dialog>
            )}
            <div className="chat-bubble chat-bubble-user">
              <UserMultimodalContent content={content} searchState={messageSearchState} />
            </div>
            {sentAt && (
              <div className="chat-msg-time-row">
                <div>{formatTime(sentAt)}</div>
                {typeof durationMs === "number" && <div className="chat-msg-duration">{formatDuration(durationMs)}</div>}
              </div>
            )}
          </div>
        </div>
      );
    }

    // Plain text message
    return (
      <div className="chat-msg chat-msg-user" {...searchAnchorProps}>
        <div className="chat-msg-user-inner">
          {showRewind && (
            <Dialog
              trigger={
                <button
                  type="button"
                  className="chat-user-rewind-btn"
                  title="回退到此消息"
                  aria-label="回退到此消息"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  ↩
                </button>
              }
            >
              <div className="text-sm font-semibold text-gray-600 mb-2">回退到此消息</div>
              <div className="text-xs text-gray-500 mb-3">回退到这条消息后，之后的消息会被删除。</div>
              <div className="flex justify-end">
                <Button
                  className="!text-xs"
                  onPress={() => onRewindToUserMessage(messageIndex)}
                >
                  确认回退
                </Button>
              </div>
            </Dialog>
          )}
          <div className="chat-bubble chat-bubble-user">{renderHighlightedText(content, messageSearchState)}</div>
          {sentAt && (
            <div className="chat-msg-time-row">
              <div>{formatTime(sentAt)}</div>
              {typeof durationMs === "number" && <div className="chat-msg-duration">{formatDuration(durationMs)}</div>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Tool result message (OpenAI format)
  if (role === "tool") {
    return <ToolResultBlock msg={msg} />;
  }

  if (role === "error") {
    return <ErrorResultBlock msg={msg} />;
  }

  // Assistant message
  if (role === "assistant") {
    const rendered = [];

    // Anthropic format: content is array of blocks
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block) continue;
        if (block.type === "text" && block.text) {
          rendered.push(<AssistantTextBubble key={`t${i}`} text={block.text} searchState={messageSearchState} />);
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          rendered.push(<ThinkingBlock key={`th${i}`} block={block} />);
        } else if (block.type === "tool_use") {
          rendered.push(<ToolCallBlock key={`tc${i}`} name={block.name} input={block.input} />);
        }
      }
    }

    // OpenAI format: tool_calls array on the message object
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Render text content if present
      if (content && typeof content === "string") {
        rendered.push(<AssistantTextBubble key="text" text={content} searchState={messageSearchState} />);
      }
      for (let i = 0; i < msg.tool_calls.length; i++) {
        const tc = msg.tool_calls[i];
        // Extract name — could be in tc.function.name or tc.name
        const toolName = tc.function?.name || tc.name || "tool";
        // Extract arguments — could be string or object, in various locations
        let input = tc.function?.arguments ?? tc.arguments ?? tc.args ?? {};
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch (e) { input = { raw: input }; }
        }
        rendered.push(<ToolCallBlock key={`otc${i}`} name={toolName} input={input} />);
      }
    }

    if (rendered.length === 0) {
      const fallbackThinkingBlocks = extractThinkingBlocksFromMessage(msg);
      for (let i = 0; i < fallbackThinkingBlocks.length; i++) {
        rendered.push(<ThinkingBlock key={`fth${i}`} block={fallbackThinkingBlocks[i]} />);
      }
    }

    if ((!msg.tool_calls || msg.tool_calls.length === 0) && content && typeof content === "string") {
      rendered.push(<AssistantTextBubble key="plain" text={content} searchState={messageSearchState} />);
    }

    // If we rendered something from array/tool_calls, return it
    if (rendered.length > 0) return <>{rendered}</>;

    // Plain text only
    if (content && typeof content === "string") {
      return <AssistantTextBubble text={content} searchState={messageSearchState} />;
    }

    // Empty or null content with no tool_calls — skip
    return null;
  }

  return null;

});

export default ChatMessage;

/** Render user multimodal content (text + images) */
/* eslint-disable react/prop-types */
function UserMultimodalContent({ content, searchState }) {
  if (!Array.isArray(content)) return null;

  return (
    <>
      {content.map((block, index) => {
        if (block.type === "text") {
          return <div key={index}>{renderHighlightedText(block.text, searchState)}</div>;
        }
        if (block.type === "file") {
          return (
            <div key={index} style={{ marginTop: index > 0 ? "8px" : "0", display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#374151" }}>
              <span>📄</span>
              <span>{block.fileName}</span>
            </div>
          );
        }
        if (block.type === "image" && block.source) {
          const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
          return (
            <div key={index} style={{ marginTop: index > 0 ? "8px" : "0" }}>
              <img
                src={dataUrl}
                alt="用户上传的图片"
                style={{
                  display: "block",
                  maxWidth: "min(50%, 300px)",
                  height: "auto",
                  borderRadius: "6px",
                  background: "#f5f5f5"
                }}
              />
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

/** Markdown-rendered assistant text bubble */
export function AssistantTextBubble({ text, searchState }) {
  const [copied, setCopied] = useState(false);
  const [hideCopyButton, setHideCopyButton] = useState(false);
  const hasSearchHits = !!searchState?.query && findTextHits(text, searchState.query).length > 0;

  useEffect(() => {
    chrome.storage.local.get({ hideCopyButton: false }, (res) => {
      setHideCopyButton(!!res.hideCopyButton);
    });
    const handleChange = (changes) => {
      if (changes.hideCopyButton) {
        setHideCopyButton(!!changes.hideCopyButton.newValue);
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, []);

  async function handleCopy(event) {
    event.stopPropagation();
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  }

  return (
    <div className="chat-msg chat-msg-assistant" {...(searchState ? {
      "data-chat-search-message-index": searchState.messageIndex
    } : {})}>
      <div className="chat-bubble chat-bubble-assistant">
        {hasSearchHits ? (
          <div className="chat-search-raw-markdown">{renderHighlightedText(text, searchState)}</div>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={buildAssistantRehypePlugins()}
            components={{ pre: CodeBlock }}
          >
            {text}
          </ReactMarkdown>
        )}
        {!hideCopyButton && (
          <div className="chat-bubble-copy-row">
            <button
              type="button"
              className={`chat-bubble-copy-btn ${copied ? "chat-bubble-copy-btn-copied" : ""}`}
              onClick={handleCopy}
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function AssistantThinkingBubble({ text }) {
  return <ThinkingBlock block={{ type: "thinking", thinking: text }} />;
}

function CodeBlock({ children, className = "", ...props }) {
  const [copied, setCopied] = useState(false);
  const codeText = extractReactText(children);

  async function handleCopy(event) {
    event.stopPropagation();
    try {
      await copyTextToClipboard(codeText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error("Failed to copy code block:", error);
    }
  }

  return (
    <div className="chat-code-block">
      <button
        type="button"
        className={`chat-code-copy-btn ${copied ? "chat-code-copy-btn-copied" : ""}`}
        onClick={handleCopy}
        disabled={!codeText}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre {...props} className={`chat-code-pre ${className}`.trim()}>
        {children}
      </pre>
    </div>
  );
}

/**
 * Collapsed block showing which tool was called.
 * Handles various data shapes defensively.
 */
/* eslint-disable react/prop-types */
function ToolCallBlock({ name, input }) {
  const [expanded, setExpanded] = useState(false);
  const label = name || "tool";

  let detail = "";
  if (!input || typeof input !== "object") {
    detail = String(input || "");
  } else if (input.tabId) {
    detail = `Tab ${input.tabId}`;
  } else if (input.tabIds) {
    detail = `${input.tabIds.length} tabs`;
  } else if (input.url) {
    detail = input.url;
  } else if (input.query) {
    detail = input.query;
  } else {
    detail = JSON.stringify(input);
  }

  return (
    <div className="tool-result-msg" onClick={() => setExpanded(!expanded)}>
      <div className="tool-result-header">
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">🔧 {label}({detail})</span>
      </div>
      {expanded && (
        <pre className="tool-result-content">
          {typeof input === "object" ? JSON.stringify(input, null, 2) : String(input)}
        </pre>
      )}
    </div>
  );
}

/* eslint-disable react/prop-types */
function ThinkingBlock({ block }) {
  const [expanded, setExpanded] = useState(false);
  const isRedacted = block?.type === "redacted_thinking";
  const thinkingText = typeof block?.thinking === "string" ? block.thinking : "";
  const signature = typeof block?.signature === "string" ? block.signature : "";
  const redactedData = typeof block?.data === "string" ? block.data : "";
  const summary = isRedacted ? "内容已脱敏" : buildThinkingSummary(thinkingText);

  return (
    <div className="tool-result-msg thinking-result-msg" onClick={() => setExpanded(!expanded)}>
      <div className="tool-result-header">
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">💭 {summary}</span>
      </div>
      {expanded && (
        <div className="thinking-result-content" onClick={(event) => event.stopPropagation()}>
          {isRedacted ? (
            <pre className="tool-result-content">{redactedData || "redacted_thinking"}</pre>
          ) : (
            <div className="thinking-markdown-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={buildAssistantRehypePlugins()}
                components={{ pre: CodeBlock }}
              >
                {thinkingText || "_空内容_"}
              </ReactMarkdown>
            </div>
          )}
          {signature && (
            <details className="thinking-signature-block">
              <summary>signature</summary>
              <pre className="tool-result-content">{signature}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** Collapsed block showing tool execution result (success or failure) */
/* eslint-disable react/prop-types */
function ToolResultBlock({ msg }) {
  const [expanded, setExpanded] = useState(false);
  const { content, displayImageUrl, tool_name: toolName, durationMs } = msg;
  const durationStr = typeof durationMs === "number" ? ` ${durationMs}ms` : "";

  if (msg._pending) {
    return (
      <div className="tool-result-msg">
        <div className="tool-result-header">
          <span className="tool-result-arrow">▶</span>
          <span className="tool-result-label">⏳ {toolName || "tool"}…</span>
        </div>
      </div>
    );
  }

  let label = "tool result";
  let isError = false;

  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
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
    } catch (e) { /* use default */ }
  } else if (typeof content === "object" && content !== null) {
    // content could be an object if not stringified
    if (content.error) { isError = true; label = content.error; }
    else if (content.title) label = content.title;
    else if (content.success) label = content.url || content.name || "success";
  }

  const displayContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (toolName && label === "success") {
    label = toolName;
  }

  return (
    <div className={`tool-result-msg ${isError ? "tool-result-error" : ""}`} onClick={() => setExpanded(!expanded)}>
      <div className="tool-result-header">
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">{isError ? "❌" : "✅"} <span className="tool-duration">{durationStr}</span>{label}</span>
      </div>
      {displayImageUrl && (
        <div className="tool-result-content" style={{ paddingTop: "8px", paddingBottom: expanded ? "8px" : "0" }}>
          <img
            src={displayImageUrl}
            alt={toolName || "tool screenshot"}
            style={{
              display: "block",
              maxWidth: "100%",
              width: "100%",
              maxHeight: expanded ? "420px" : "180px",
              objectFit: "contain",
              borderRadius: "8px",
              background: "#f5f5f5"
            }}
          />
        </div>
      )}
      {expanded && (
        <pre className="tool-result-content">{displayContent}</pre>
      )}
    </div>
  );
}

/* eslint-disable react/prop-types */
function ErrorResultBlock({ msg }) {
  const [expanded, setExpanded] = useState(false);
  const payload = typeof msg.content === "string" ? safeJsonParse(msg.content) : (msg.content || {});
  const code = payload?.code || "LLM_ERROR";
  const message = payload?.message || "LLM 请求失败";
  const attempts = Number(payload?.attempts) || 1;
  const maxAttempts = Number(payload?.maxAttempts) || attempts;
  const summary = `${code}: ${message}`;
  const detail = {
    ...payload,
    attempts,
    maxAttempts
  };

  return (
    <div className="tool-result-msg tool-result-error" onClick={() => setExpanded(!expanded)}>
      <div className="tool-result-header">
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">❌ {summary}（重试 {attempts}/{maxAttempts}）</span>
      </div>
      {expanded && (
        <pre className="tool-result-content">{JSON.stringify(detail, null, 2)}</pre>
      )}
    </div>
  );
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return { raw: value };
  }
}

function extractThinkingBlocksFromMessage(msg) {
  const blocks = [];

  if (Array.isArray(msg?.thinking_blocks)) {
    blocks.push(...msg.thinking_blocks);
  }

  const providerReasoningBlocks = msg?.provider_specific_fields?.reasoningContentBlocks;
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

  if (blocks.length === 0 && typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    blocks.push({ type: "thinking", thinking: msg.reasoning_content });
  }

  if (blocks.length === 0 && typeof msg?.reasoning === "string" && msg.reasoning.length > 0) {
    blocks.push({ type: "thinking", thinking: msg.reasoning });
  }

  if (blocks.length === 0 && typeof msg?.thinking === "string" && msg.thinking.length > 0) {
    blocks.push({ type: "thinking", thinking: msg.thinking });
  }

  if (blocks.length === 0) {
    const reasoningDetailsText = flattenReasoningDetails(msg?.reasoning_details);
    if (reasoningDetailsText) {
      blocks.push({ type: "thinking", thinking: reasoningDetailsText });
    }
  }

  return blocks.filter(isRenderableThinkingBlock);
}

function isRenderableThinkingBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking") {
    return typeof block.thinking === "string" || typeof block.signature === "string";
  }
  if (block.type === "redacted_thinking") {
    return typeof block.data === "string" && block.data.length > 0;
  }
  return false;
}

function flattenReasoningDetails(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(flattenReasoningDetails).filter(Boolean).join("\n\n").trim();
  }
  if (value && typeof value === "object") {
    return [
      value.text,
      value.reasoning,
      value.summary,
      value.content,
      value.output_text
    ].map(flattenReasoningDetails).filter(Boolean).join("\n\n").trim();
  }
  return "";
}

function buildThinkingSummary(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "空";
  return normalized.length > 60 ? `${normalized.slice(0, 60)}...` : normalized;
}

function buildMessageSearchState(searchState, messageIndex) {
  if (!searchState || typeof messageIndex !== "number") return null;
  const query = String(searchState.query || "").trim();
  if (!query) return null;
  return {
    messageIndex,
    query
  };
}

function isSearchableChatMessage(message) {
  if (!message) return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  if (Array.isArray(message.content) && message.content.some(block => block?.type === "tool_use" || block?.type === "tool_result")) {
    return false;
  }
  return true;
}

function buildAssistantRehypePlugins() {
  return [[rehypeHighlight, { detect: true, ignoreMissing: true }]];
}

function renderHighlightedText(value, searchState) {
  const text = String(value ?? "");
  if (!searchState?.query) return text;

  const sortedHits = findTextHits(text, searchState.query);
  if (sortedHits.length === 0) return text;
  const parts = [];
  let cursor = 0;
  sortedHits.forEach((hit, index) => {
    const start = Math.max(cursor, Math.min(text.length, hit.start));
    const end = Math.max(start, Math.min(text.length, hit.end));
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start) {
      parts.push(
        <mark
          key={`hit-${hit.start}-${index}`}
          className="chat-search-hit"
          data-chat-search-hit="true"
          data-chat-search-message-index={searchState.messageIndex}
        >
          {text.slice(start, end)}
        </mark>
      );
    }
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function findTextHits(text, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return [];
  const lowerText = String(text || "").toLowerCase();
  const hits = [];
  let fromIndex = 0;
  while (fromIndex < lowerText.length) {
    const start = lowerText.indexOf(normalizedQuery, fromIndex);
    if (start < 0) break;
    hits.push({ start, end: start + normalizedQuery.length });
    fromIndex = start + Math.max(1, normalizedQuery.length);
  }
  return hits;
}

function extractReactText(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(extractReactText).join("");
  if (typeof value === "object" && value.props) return extractReactText(value.props.children);
  return "";
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

async function copyTextToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
