/* global chrome */
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/atom-one-dark.css";
import { Button, Dialog } from "@sunwu51/camel-ui";
import { memo, useEffect, useRef, useState } from "react";
import { normalizeImageRefSource, normalizeMessageImageRefs } from "./imageRefs";

/**
 * Render a single chat message based on its role and content.
 * @param {object} props
 * @param {object} props.msg
 * @param {number} [props.messageIndex]
 * @param {(index: number) => void} [props.onRewindToUserMessage]
 */
/* eslint-disable react/prop-types */
const ChatMessage = memo(function ChatMessage({
  msg,
  messageIndex,
  onRewindToUserMessage,
  searchState,
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver
}) {
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
    const injectedContext = normalizeInjectedUserContext(msg.injectedUserContext);
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
              <UserMultimodalContent
                content={content}
                searchState={messageSearchState}
                displayContent={msg.displayContent}
                imageRefs={msg.imageRefs}
                imageEditMeta={msg.imageEditMeta}
                imageEditingEnabled={imageEditingEnabled}
                onImageEditRequest={onImageEditRequest}
              />
              <InjectedUserContextBlock context={injectedContext} />
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
          <div className="chat-bubble chat-bubble-user">
            {renderHighlightedText(msg.displayContent || content, messageSearchState)}
            {buildSupplementalUserImages([], msg.imageRefs, msg.imageEditMeta).map((image, index) => (
              <SupplementalUserImage
                key={`plain-supplemental-image-${image.ref || index}`}
                image={image}
                imageEditingEnabled={imageEditingEnabled}
                onImageEditRequest={onImageEditRequest}
              />
            ))}
            <InjectedUserContextBlock context={injectedContext} />
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
          rendered.push(
            <AssistantTextBubble
              key={`t${i}`}
              text={block.text}
              searchState={messageSearchState}
              imageEditingEnabled={imageEditingEnabled}
              onImageEditRequest={onImageEditRequest}
              imageSrcResolver={imageSrcResolver}
            />
          );
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
        rendered.push(
          <AssistantTextBubble
            key="text"
            text={content}
            searchState={messageSearchState}
            imageEditingEnabled={imageEditingEnabled}
            onImageEditRequest={onImageEditRequest}
            imageSrcResolver={imageSrcResolver}
          />
        );
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
      rendered.push(
        <AssistantTextBubble
          key="plain"
          text={content}
          searchState={messageSearchState}
          imageEditingEnabled={imageEditingEnabled}
          onImageEditRequest={onImageEditRequest}
          imageSrcResolver={imageSrcResolver}
        />
      );
    }

    // If we rendered something from array/tool_calls, return it
    if (rendered.length > 0) return <>{rendered}</>;

    // Plain text only
    if (content && typeof content === "string") {
      return (
        <AssistantTextBubble
          text={content}
          searchState={messageSearchState}
          imageEditingEnabled={imageEditingEnabled}
          onImageEditRequest={onImageEditRequest}
          imageSrcResolver={imageSrcResolver}
        />
      );
    }

    // Empty or null content with no tool_calls — skip
    return null;
  }

  return null;

});

export default ChatMessage;

/** Render user multimodal content (text + images) */
/* eslint-disable react/prop-types */
function UserMultimodalContent({
  content,
  searchState,
  displayContent,
  imageRefs,
  imageEditMeta,
  imageEditingEnabled = false,
  onImageEditRequest
}) {
  if (!Array.isArray(content)) return null;
  let displayedText = false;
  const supplementalImages = buildSupplementalUserImages(content, imageRefs, imageEditMeta);

  return (
    <>
      {content.map((block, index) => {
        if (block.type === "text") {
          const text = displayContent && !displayedText ? displayContent : block.text;
          displayedText = true;
          return <div key={index}>{renderHighlightedText(text, searchState)}</div>;
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
          const dataUrl = block.source.type === "session_image"
            ? `session-image:${block.source.ref}`
            : `data:${block.source.media_type};base64,${block.source.data}`;
          const ref = findImageRefForSource(imageRefs, dataUrl);
          return (
            <div key={index} style={{ marginTop: index > 0 ? "8px" : "0" }}>
              <EditableChatImage
                src={dataUrl}
                alt="用户上传的图片"
                refId={ref}
                editable={imageEditingEnabled}
                onEdit={onImageEditRequest}
                wrapperClassName="chat-user-image-wrap"
                imageClassName="chat-user-image"
              />
            </div>
          );
        }
        return null;
      })}
      {supplementalImages.map((image, index) => (
        <SupplementalUserImage
          key={`supplemental-image-${image.ref || index}`}
          image={image}
          imageEditingEnabled={imageEditingEnabled}
          onImageEditRequest={onImageEditRequest}
        />
      ))}
    </>
  );
}

function buildSupplementalUserImages(content, imageRefs, imageEditMeta) {
  const renderedSources = new Set();
  for (const block of Array.isArray(content) ? content : []) {
    const source = getUserImageBlockSource(block);
    if (source) renderedSources.add(source);
  }

  const seenSupplementalSources = new Set(renderedSources);
  const editRefs = [
    ...normalizeMessageImageRefs(imageRefs),
    ...normalizeImageEditPreviewImages(imageEditMeta?.images)
  ]
    .filter(item => ["edit_image", "edit_reference", "edit_mask"].includes(item.role))
    .filter(item => {
      if (!item.dataUrl || seenSupplementalSources.has(item.dataUrl)) return false;
      seenSupplementalSources.add(item.dataUrl);
      return true;
    });

  let referenceIndex = 0;
  return editRefs.map(item => {
    let label = "图片";
    if (item.role === "edit_image") {
      label = "原图";
    } else if (item.role === "edit_reference") {
      referenceIndex += 1;
      label = `参考图 ${referenceIndex}`;
    } else if (item.role === "edit_mask") {
      label = "蒙版";
    }
    return {
      ref: item.ref,
      src: item.dataUrl,
      label
    };
  });
}

function getUserImageBlockSource(block) {
  if (!block || block.type !== "image" || !block.source) return "";
  if (block.source.type === "session_image" && block.source.ref) {
    return `session-image:${block.source.ref}`;
  }
  if (block.source.type === "base64" && block.source.media_type && block.source.data) {
    return `data:${block.source.media_type};base64,${block.source.data}`;
  }
  return "";
}

function normalizeImageEditPreviewImages(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      ref: String(item?.ref || "").trim(),
      dataUrl: normalizeImageRefSource(item?.dataUrl || item?.source || item?.url),
      role: String(item?.role || "").trim()
    }))
    .filter(item => item.dataUrl && ["edit_image", "edit_reference", "edit_mask"].includes(item.role));
}

function SupplementalUserImage({ image, imageEditingEnabled = false, onImageEditRequest }) {
  return (
    <div style={{ marginTop: "8px" }}>
      <div style={{ fontSize: "11px", lineHeight: 1.3, color: "#475569", marginBottom: "4px" }}>{image.label}</div>
      <EditableChatImage
        src={image.src}
        alt={image.label}
        refId={image.ref}
        editable={imageEditingEnabled}
        onEdit={onImageEditRequest}
        wrapperClassName="chat-user-image-wrap"
        imageClassName="chat-user-image"
      />
    </div>
  );
}

/** Markdown-rendered assistant text bubble */
export function AssistantTextBubble({
  text,
  searchState,
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver
}) {
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
            urlTransform={transformMarkdownUrl}
            components={buildAssistantMarkdownComponents({
              imageEditingEnabled,
              onImageEditRequest,
              imageSrcResolver
            })}
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
                components={buildAssistantMarkdownComponents()}
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
  const displayImages = Array.isArray(msg.displayImages) && msg.displayImages.length > 0
    ? msg.displayImages.map(image => image?.url).filter(Boolean)
    : (displayImageUrl ? [displayImageUrl] : []);
  const durationStr = typeof durationMs === "number" ? ` ${durationMs}ms` : "";

  if (msg._pending) {
    const pendingHint = isImageToolName(toolName) ? "图片生成中..." : "";
    return (
      <div className="tool-result-msg">
        <div className="tool-result-header">
          <span className="tool-result-arrow">▶</span>
          <span className="tool-result-label">⏳ {toolName || "tool"}…</span>
        </div>
        {pendingHint && <div className="tool-result-pending-hint loading-dots">{pendingHint}</div>}
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
      {expanded && displayImages.length > 0 && (
        <div className="tool-result-content" style={{ paddingTop: "8px", paddingBottom: "8px" }}>
          {displayImages.map((src, index) => (
            <img
              key={`${src}-${index}`}
              src={src}
              alt={displayImages.length > 1 ? `${toolName || "tool image"} ${index + 1}` : (toolName || "tool screenshot")}
              style={{
                display: "block",
                maxWidth: "100%",
                width: "100%",
                maxHeight: "420px",
                objectFit: "contain",
                borderRadius: "8px",
                background: "#f5f5f5",
                marginTop: index === 0 ? 0 : "8px"
              }}
            />
          ))}
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

function normalizeInjectedUserContext(context) {
  const tabs = Array.isArray(context?.tabs) ? context.tabs.filter(tab => tab?.id) : [];
  const skills = Array.isArray(context?.skills) ? context.skills.filter(skill => skill?.path) : [];
  if (tabs.length === 0 && skills.length === 0) return null;
  return { tabs, skills };
}

function InjectedUserContextBlock({ context }) {
  if (!context) return null;
  return (
    <div className="chat-user-injected-context">
      <div className="chat-user-injected-title">注入的用户消息</div>
      {context.tabs.length > 0 && (
        <div className="chat-user-injected-list">
          {context.tabs.map(tab => (
            <div key={`tab-${tab.id}`} className="chat-user-injected-item">
              <span className="chat-user-injected-kind">@tab</span>
              <span className="chat-user-injected-text">{tab.title || "未命名标签页"}</span>
              <span className="chat-user-injected-meta">#{tab.id}</span>
            </div>
          ))}
        </div>
      )}
      {context.skills.length > 0 && (
        <div className="chat-user-injected-list">
          {context.skills.map(skill => (
            <div key={`skill-${skill.path}`} className="chat-user-injected-item">
              <span className="chat-user-injected-kind">/skill</span>
              <span className="chat-user-injected-text">{skill.name || skill.path}</span>
              <span className="chat-user-injected-meta">{skill.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildAssistantMarkdownComponents({
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver
} = {}) {
  return {
    pre: CodeBlock,
    a: MarkdownLink,
    img: (props) => (
      <MarkdownImage
        {...props}
        editable={imageEditingEnabled}
        onImageEditRequest={onImageEditRequest}
        imageSrcResolver={imageSrcResolver}
      />
    )
  };
}

function MarkdownImage({ src, alt, editable = false, onImageEditRequest, imageSrcResolver, ...props }) {
  delete props.node;
  const refId = extractImageDerefRef(src);
  const imageSrc = normalizeMarkdownImageSrc(src, imageSrcResolver);
  if (!imageSrc) return null;

  return (
    <EditableChatImage
      {...props}
      src={imageSrc}
      alt={alt || "图片"}
      refId={refId}
      editable={editable}
      onEdit={onImageEditRequest}
      wrapperClassName="chat-assistant-image-wrap"
      imageClassName="chat-assistant-image"
    />
  );
}

function EditableChatImage({
  src,
  alt,
  refId,
  editable = false,
  onEdit,
  wrapperClassName = "",
  imageClassName = "",
  ...imgProps
}) {
  const isPendingSessionImage = typeof src === "string" && src.startsWith("session-image:");
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewFitZoom, setPreviewFitZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const previewImageRef = useRef(null);
  const previewStageRef = useRef(null);
  const previewDragRef = useRef(null);

  function handleEditClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!editable || typeof onEdit !== "function") return;
    onEdit({ src, alt, ref: refId || "" });
  }

  function handleRefClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!refId || isPendingSessionImage || !src) return;
    setPreviewZoom(1);
    setPreviewFitZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
    setIsPreviewOpen(true);
  }

  useEffect(() => {
    if (!isPreviewOpen) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsPreviewOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreviewOpen]);

  useEffect(() => {
    if (!isPreviewOpen) return undefined;
    const stage = previewStageRef.current;
    if (!stage) return undefined;

    function handlePreviewWheel(event) {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 0.2 : -0.2);
    }

    stage.addEventListener("wheel", handlePreviewWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handlePreviewWheel);
  }, [isPreviewOpen]);

  useEffect(() => {
    if (!isPreviewOpen) return undefined;
    const stage = previewStageRef.current;
    const image = previewImageRef.current;
    if (!stage || !image) return undefined;

    const updateFitZoom = () => {
      const naturalWidth = image.naturalWidth || image.width || 0;
      const naturalHeight = image.naturalHeight || image.height || 0;
      const stageRect = stage.getBoundingClientRect();
      const stageWidth = Math.max(1, stageRect.width - 40);
      const stageHeight = Math.max(1, stageRect.height - 40);
      const fitZoom = naturalWidth > 0 && naturalHeight > 0
        ? Math.min(1, stageWidth / naturalWidth, stageHeight / naturalHeight)
        : 1;
      const nextZoom = clampImagePreviewZoom(fitZoom || 1);
      setPreviewFitZoom(nextZoom);
      setPreviewZoom(nextZoom);
      setPreviewOffset({ x: 0, y: 0 });
    };

    updateFitZoom();
    image.addEventListener("load", updateFitZoom);
    window.addEventListener("resize", updateFitZoom);
    return () => {
      image.removeEventListener("load", updateFitZoom);
      window.removeEventListener("resize", updateFitZoom);
    };
  }, [isPreviewOpen, src]);

  function zoomBy(delta) {
    setPreviewZoom(current => clampImagePreviewZoom(current + delta));
  }

  function fitPreviewToWindow() {
    setPreviewZoom(previewFitZoom);
    setPreviewOffset({ x: 0, y: 0 });
  }

  function showOriginalSize() {
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
  }

  function handlePreviewPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    previewDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: previewOffset.x,
      originY: previewOffset.y
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handlePreviewPointerMove(event) {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPreviewOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY
    });
  }

  function finishPreviewDrag(event) {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    previewDragRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      typeof event.currentTarget.releasePointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <>
      <span className={`chat-editable-image-wrap ${wrapperClassName}`.trim()}>
        {isPendingSessionImage ? (
          <span className={`${imageClassName} chat-image-placeholder`}>
            图片加载中...
          </span>
        ) : (
          <img
            {...imgProps}
            src={src}
            alt={alt}
            className={imageClassName}
            loading="lazy"
            decoding="async"
          />
        )}
        {!isPendingSessionImage && (refId || editable) && (
          <span className="chat-image-actions">
            {refId && (
              <button
                type="button"
                className="chat-image-ref-btn"
                onClick={handleRefClick}
                title={`预览 ${refId}`}
                aria-label={`预览 ${refId}`}
              >
                {refId}
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="chat-image-edit-btn"
                onClick={handleEditClick}
                title="编辑图片"
                aria-label="编辑图片"
              >
                Edit
              </button>
            )}
          </span>
        )}
      </span>
      {isPreviewOpen && !isPendingSessionImage && src && (
        <div
          className="chat-image-preview-backdrop"
          onClick={() => setIsPreviewOpen(false)}
        >
          <div
            className="chat-image-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={refId ? `${refId} 图片预览` : "图片预览"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="chat-image-preview-toolbar">
              <div className="chat-image-preview-title">{refId || alt || "图片预览"}</div>
              <div className="chat-image-preview-controls">
                <button type="button" className="chat-image-preview-btn" onClick={() => zoomBy(-0.2)} aria-label="缩小图片">-</button>
                <button type="button" className="chat-image-preview-btn" onClick={() => zoomBy(0.2)} aria-label="放大图片">+</button>
                <button type="button" className="chat-image-preview-btn" onClick={fitPreviewToWindow} aria-label="适应窗口">适应</button>
                <button type="button" className="chat-image-preview-btn" onClick={showOriginalSize} aria-label="原图大小">100%</button>
                <button type="button" className="chat-image-preview-btn" onClick={() => setIsPreviewOpen(false)} aria-label="关闭图片预览">关闭</button>
              </div>
            </div>
            <div className="chat-image-preview-meta">
              <span>{Math.round(previewZoom * 100)}%</span>
              <span className="chat-image-preview-hint">滚轮缩放，按住拖拽查看细节</span>
            </div>
            <div
              ref={previewStageRef}
              className="chat-image-preview-stage"
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={handlePreviewPointerMove}
              onPointerUp={finishPreviewDrag}
              onPointerCancel={finishPreviewDrag}
            >
              <img
                ref={previewImageRef}
                src={src}
                alt={alt}
                className="chat-image-preview-image"
                draggable={false}
                style={{ transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewZoom})` }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function clampImagePreviewZoom(value) {
  return Math.max(0.2, Math.min(6, Math.round(value * 100) / 100));
}

function findImageRefForSource(imageRefs, source) {
  if (!Array.isArray(imageRefs) || !source) return "";
  const match = imageRefs.find(item => item?.dataUrl === source || item?.source === source || item?.url === source);
  return match?.ref || "";
}

function transformMarkdownUrl(value, key, node) {
  if (key === "src" && node?.tagName === "img" && extractImageDerefRef(value)) {
    return String(value || "");
  }
  return defaultUrlTransform(value);
}

function extractImageDerefRef(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // Keep the raw candidate when the URL is not percent encoded.
  }

  for (const candidate of candidates) {
    let value = candidate.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    const match = value.match(/^\|deRef:(img_[A-Za-z0-9_-]+)\|$/);
    if (match) return match[1];
  }

  return "";
}

function normalizeMarkdownImageSrc(src, imageSrcResolver) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  const ref = extractImageDerefRef(raw);
  if (ref) {
    if (typeof imageSrcResolver !== "function") return "";
    return normalizeDirectMarkdownImageSrc(imageSrcResolver(ref));
  }
  return normalizeDirectMarkdownImageSrc(raw);
}

function normalizeDirectMarkdownImageSrc(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  if (/^(data:image\/[^;]+;base64,|https?:\/\/|blob:|chrome-extension:\/\/)/i.test(raw)) return raw;

  try {
    const resolved = new URL(raw, window.location.href);
    if (["http:", "https:", "blob:", "chrome-extension:"].includes(resolved.protocol)) {
      return resolved.href;
    }
  } catch {
    return "";
  }

  return "";
}

function MarkdownLink({ href, children, ...props }) {
  const safeHref = normalizeMarkdownHref(href);

  async function handleClick(event) {
    if (!safeHref || safeHref.startsWith("#")) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      if (/^https?:/i.test(safeHref) && typeof chrome !== "undefined" && chrome.tabs?.create) {
        await chrome.tabs.create({ url: safeHref, active: true });
        return;
      }
    } catch (error) {
      console.error("Failed to open markdown link in tab:", error);
    }

    window.open(safeHref, "_blank", "noopener,noreferrer");
  }

  return (
    <a
      {...props}
      href={safeHref || undefined}
      target={safeHref && !safeHref.startsWith("#") ? "_blank" : undefined}
      rel={safeHref && !safeHref.startsWith("#") ? "noopener noreferrer" : undefined}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

function normalizeMarkdownHref(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  if (raw.startsWith("#")) return raw;

  try {
    const resolved = new URL(raw, window.location.href);
    if (["http:", "https:", "mailto:", "tel:"].includes(resolved.protocol)) {
      return resolved.href;
    }
  } catch {
    return "";
  }

  return "";
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

function isImageToolName(name) {
  return name === "image_gen" || name === "image_edit";
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
