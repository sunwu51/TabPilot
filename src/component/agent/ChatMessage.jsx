/* global chrome */
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/atom-one-dark.css";
import { Button, Dialog } from "@sunwu51/camel-ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeImageRefSource, normalizeMessageImageRefs } from "./imageRefs";
import { buildWebSearchActionLabels } from "./webSearchActions";

let activeSpeechController = null;

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
  sessionId = "",
  searchState,
  imageEditingEnabled = false,
  onImageEditRequest,
  imageSrcResolver,
  imageRefNavigator
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
                sessionId={sessionId}
                imageEditingEnabled={imageEditingEnabled}
                onImageEditRequest={onImageEditRequest}
                imageRefNavigator={imageRefNavigator}
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
                sessionId={sessionId}
                imageEditingEnabled={imageEditingEnabled}
                onImageEditRequest={onImageEditRequest}
                imageRefNavigator={imageRefNavigator}
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
    return <ToolResultBlock msg={msg} sessionId={sessionId} imageRefNavigator={imageRefNavigator} />;
  }

  if (role === "error") {
    return <ErrorResultBlock msg={msg} />;
  }

  // Assistant message
  if (role === "assistant") {
    const rendered = [];
    if (Array.isArray(msg.web_searches) && msg.web_searches.length > 0) {
      rendered.push(<AssistantWebSearchBubble key="web-searches" actions={msg.web_searches} />);
    }

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
              imageRefNavigator={imageRefNavigator}
              sessionId={sessionId}
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
              imageRefNavigator={imageRefNavigator}
              sessionId={sessionId}
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
          imageRefNavigator={imageRefNavigator}
          sessionId={sessionId}
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
          imageRefNavigator={imageRefNavigator}
          sessionId={sessionId}
        />
      );
    }

    // Empty or null content with no tool_calls — skip
    return null;
  }

  return null;

});

/* eslint-disable react/prop-types */
function AssistantWebSearchBubble({ actions = [] }) {
  return (
    <div className="chat-msg chat-msg-assistant">
      <div className="chat-bubble chat-bubble-assistant native-web-search-bubble">
        <strong>联网搜索</strong>
        {actions.map((action, index) => {
          return buildWebSearchActionLabels(action).map((label, labelIndex) => (
            <div key={`${action?.type || "action"}-${index}-${labelIndex}`}>✓ {label}</div>
          ));
        })}
      </div>
    </div>
  );
}
/* eslint-enable react/prop-types */

export default ChatMessage;

/** Render user multimodal content (text + images) */
/* eslint-disable react/prop-types */
function UserMultimodalContent({
  content,
  searchState,
  displayContent,
  imageRefs,
  imageEditMeta,
  sessionId = "",
  imageEditingEnabled = false,
  onImageEditRequest,
  imageRefNavigator
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
                sessionId={sessionId}
                editable={imageEditingEnabled}
                onEdit={onImageEditRequest}
                imageRefNavigator={imageRefNavigator}
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
          sessionId={sessionId}
          imageEditingEnabled={imageEditingEnabled}
          onImageEditRequest={onImageEditRequest}
          imageRefNavigator={imageRefNavigator}
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

function SupplementalUserImage({ image, sessionId = "", imageEditingEnabled = false, onImageEditRequest, imageRefNavigator }) {
  return (
    <div style={{ marginTop: "8px" }}>
      <div style={{ fontSize: "11px", lineHeight: 1.3, color: "#475569", marginBottom: "4px" }}>{image.label}</div>
      <EditableChatImage
        src={image.src}
        alt={image.label}
        refId={image.ref}
        sessionId={sessionId}
        editable={imageEditingEnabled}
        onEdit={onImageEditRequest}
        imageRefNavigator={imageRefNavigator}
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
  imageSrcResolver,
  imageRefNavigator,
  sessionId = ""
}) {
  const [copied, setCopied] = useState(false);
  const [hideCopyButton, setHideCopyButton] = useState(false);
  const [ttsVoiceName, setTtsVoiceName] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utteranceRef = useRef(null);
  const hasSearchHits = !!searchState?.query && findTextHits(text, searchState.query).length > 0;
  const canSpeak = typeof window !== "undefined" && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined";

  useEffect(() => {
    chrome.storage.local.get({ hideCopyButton: false, ttsVoiceName: "" }, (res) => {
      setHideCopyButton(!!res.hideCopyButton);
      setTtsVoiceName(typeof res.ttsVoiceName === "string" ? res.ttsVoiceName : "");
    });
    const handleChange = (changes) => {
      if (changes.hideCopyButton) {
        setHideCopyButton(!!changes.hideCopyButton.newValue);
      }
      if (changes.ttsVoiceName) {
        setTtsVoiceName(typeof changes.ttsVoiceName.newValue === "string" ? changes.ttsVoiceName.newValue : "");
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, []);

  useEffect(() => {
    return () => {
      const speech = window.speechSynthesis;
      if (utteranceRef.current && speech?.speaking) {
        speech.cancel();
      }
      if (activeSpeechController?.utterance === utteranceRef.current) {
        activeSpeechController = null;
      }
      utteranceRef.current = null;
    };
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

  function handleSpeak(event) {
    event.stopPropagation();
    if (!canSpeak) return;
    const speech = window.speechSynthesis;
    if (isSpeaking && utteranceRef.current) {
      speech.cancel();
      setIsSpeaking(false);
      if (activeSpeechController?.utterance === utteranceRef.current) {
        activeSpeechController = null;
      }
      utteranceRef.current = null;
      return;
    }

    speech.cancel();
    activeSpeechController?.stop?.();
    const speakText = markdownToSpeechText(text);
    if (!speakText) return;
    const utterance = new SpeechSynthesisUtterance(speakText);
    const selectedVoice = resolveSpeechSynthesisVoice(speech.getVoices(), ttsVoiceName);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      setIsSpeaking(false);
      if (utteranceRef.current === utterance) utteranceRef.current = null;
      if (activeSpeechController?.utterance === utterance) activeSpeechController = null;
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      if (utteranceRef.current === utterance) utteranceRef.current = null;
      if (activeSpeechController?.utterance === utterance) activeSpeechController = null;
    };
    utteranceRef.current = utterance;
    activeSpeechController = {
      utterance,
      stop: () => {
        setIsSpeaking(false);
        if (utteranceRef.current === utterance) utteranceRef.current = null;
      }
    };
    speech.speak(utterance);
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
              imageSrcResolver,
              imageRefNavigator,
              sessionId
            })}
          >
            {text}
          </ReactMarkdown>
        )}
        {!hideCopyButton && (
          <div className="chat-bubble-copy-row">
            {canSpeak && (
              <button
                type="button"
                className={`chat-bubble-copy-btn ${isSpeaking ? "chat-bubble-speak-btn-active" : ""}`}
                onClick={handleSpeak}
              >
                {isSpeaking ? "停止" : "播报"}
              </button>
            )}
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
function ToolResultBlock({ msg, sessionId = "", imageRefNavigator }) {
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
            <EditableChatImage
              key={`${src}-${index}`}
              src={src}
              alt={displayImages.length > 1 ? `${toolName || "tool image"} ${index + 1}` : (toolName || "tool screenshot")}
              refId={getToolDisplayImageRef(msg, src)}
              sessionId={sessionId}
              imageRefNavigator={imageRefNavigator}
              wrapperClassName={`chat-tool-image-wrap ${index > 0 ? "chat-tool-image-wrap-spaced" : ""}`}
              imageClassName="chat-tool-image"
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

function getToolDisplayImageRef(msg, src) {
  const imageSrc = normalizeImageRefSource(src);
  if (!imageSrc) return "";
  if (Array.isArray(msg?.displayImages)) {
    const match = msg.displayImages.find(image => normalizeImageRefSource(image?.url) === imageSrc);
    if (match?.ref) return match.ref;
  }
  if (normalizeImageRefSource(msg?.displayImageUrl) === imageSrc && msg?.displayImageRef) {
    return msg.displayImageRef;
  }
  const refs = normalizeMessageImageRefs(msg?.imageRefs);
  return refs.find(item => item.dataUrl === imageSrc)?.ref || "";
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
  return [rehypeRaw, [rehypeHighlight, { detect: true, ignoreMissing: true }]];
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
  imageSrcResolver,
  imageRefNavigator,
  sessionId = ""
} = {}) {
  return {
    pre: CodeBlock,
    a: MarkdownLink,
    audio: MarkdownAudio,
    img: (props) => (
      <MarkdownImage
        {...props}
        editable={imageEditingEnabled}
        onImageEditRequest={onImageEditRequest}
        imageSrcResolver={imageSrcResolver}
        imageRefNavigator={imageRefNavigator}
        sessionId={sessionId}
      />
    )
  };
}

function MarkdownAudio({ src }) {
  const safeSrc = normalizeMarkdownAudioSrc(src);
  if (!safeSrc) return null;
  return (
    <audio
      className="chat-assistant-audio"
      src={safeSrc}
      controls
      preload="metadata"
    />
  );
}

function resolveSpeechSynthesisVoice(voices, preferredName) {
  const availableVoices = Array.isArray(voices) ? voices : [];
  const normalizedName = String(preferredName || "").trim();
  if (normalizedName) {
    const exactMatch = availableVoices.find(voice => voice?.name === normalizedName);
    if (exactMatch) return exactMatch;
  }
  return (
    availableVoices.find(voice => speechVoiceHasText(voice, "mainland")) ||
    availableVoices.find(voice => String(voice?.lang || "").toLowerCase().includes("zh")) ||
    null
  );
}

function speechVoiceHasText(voice, text) {
  const needle = String(text || "").toLowerCase();
  if (!needle) return false;
  return [voice?.name, voice?.lang, voice?.voiceURI]
    .map(value => String(value || "").toLowerCase())
    .some(value => value.includes(needle));
}

function markdownToSpeechText(markdown) {
  let value = String(markdown || "");
  if (!value.trim()) return "";

  value = value.replace(/```[\s\S]*?```/g, "\n");
  value = value.replace(/~~~[\s\S]*?~~~/g, "\n");
  value = value.replace(/<audio\b[\s\S]*?<\/audio>/gi, "\n");
  value = value.replace(/<[^>]+>/g, " ");
  value = value.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  value = value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  value = value.replace(/`([^`]*)`/g, "$1");
  value = value.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  value = value.replace(/^\s{0,3}>\s?/gm, "");
  value = value.replace(/^\s*[-*+]\s+/gm, "");
  value = value.replace(/^\s*\d+[.)]\s+/gm, "");
  value = value.replace(/^\s*[-:| ]{3,}\s*$/gm, "");
  value = value.replace(/[|*_~#>`[\]()]/g, " ");
  value = value.replace(/https?:\/\/\S+/gi, " ");
  value = value.replace(/[ \t]+/g, " ");
  value = value.replace(/\n{3,}/g, "\n\n");
  return value.trim();
}

function MarkdownImage({ src, alt, editable = false, onImageEditRequest, imageSrcResolver, imageRefNavigator, sessionId = "", ...props }) {
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
      sessionId={sessionId}
      editable={editable}
      onEdit={onImageEditRequest}
      imageRefNavigator={imageRefNavigator}
      wrapperClassName="chat-assistant-image-wrap"
      imageClassName="chat-assistant-image"
    />
  );
}

export function EditableChatImage({
  src,
  alt,
  refId,
  sessionId = "",
  editable = false,
  onEdit,
  imageRefNavigator,
  wrapperClassName = "",
  imageClassName = "",
  ...imgProps
}) {
  const isPendingSessionImage = typeof src === "string" && src.startsWith("session-image:");
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState(() => ({ src, refId: refId || "", alt }));
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewFitZoom, setPreviewFitZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const previewImageRef = useRef(null);
  const previewStageRef = useRef(null);
  const previewDragRef = useRef(null);
  const canPreviewImage = !isPendingSessionImage && !!src;
  const previewSrc = previewImage.src || src;
  const previewRefId = previewImage.refId || "";
  const previewAlt = previewImage.alt || alt || "图片";
  const isPreviewHttpImageSrc = /^https?:\/\//i.test(String(previewSrc || ""));
  const canNavigatePreviewRefs = !!previewRefId && typeof imageRefNavigator === "function";
  const previewRefNavigation = useMemo(() => {
    if (!canNavigatePreviewRefs) return { prev: null, next: null };
    return {
      prev: imageRefNavigator(previewRefId, "prev"),
      next: imageRefNavigator(previewRefId, "next")
    };
  }, [canNavigatePreviewRefs, imageRefNavigator, previewRefId]);
  const canOpenInNewTab = (!!sessionId && !!previewRefId) || isPreviewHttpImageSrc;
  const previewButtonLabel = refId || "预览";
  const previewButtonTitle = refId ? `预览 ${refId}` : "预览图片";

  function handleEditClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!editable || typeof onEdit !== "function") return;
    onEdit({ src, alt, ref: refId || "" });
  }

  function handleRefClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!canPreviewImage) return;
    setPreviewImage({ src, refId: refId || "", alt });
    setPreviewZoom(1);
    setPreviewFitZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
    setIsPreviewOpen(true);
  }

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
  }, [isPreviewOpen, previewSrc]);

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

  const resetPreviewViewport = useCallback(() => {
    setPreviewZoom(1);
    setPreviewFitZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
  }, []);

  const navigatePreviewImage = useCallback((direction) => {
    if (!canNavigatePreviewRefs) return;
    const next = previewRefNavigation[direction];
    if (!next?.ref || !next?.src) return;
    setPreviewImage({
      src: next.src,
      refId: next.ref,
      alt: next.ref
    });
    resetPreviewViewport();
  }, [canNavigatePreviewRefs, previewRefNavigation, resetPreviewViewport]);

  function stopPreviewNavPointer(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  useEffect(() => {
    if (!isPreviewOpen) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsPreviewOpen(false);
      } else if (event.key === "ArrowLeft") {
        navigatePreviewImage("prev");
      } else if (event.key === "ArrowRight") {
        navigatePreviewImage("next");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreviewOpen, navigatePreviewImage]);

  function getPreviewImageFilename() {
    const base = String(previewRefId || previewAlt || "image")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "image";
    return `${base}.${inferImageExtension(previewSrc)}`;
  }

  async function openPreviewInNewTab() {
    if (!canOpenInNewTab) return;
    if (isPreviewHttpImageSrc) {
      if (chrome?.tabs?.create) {
        await chrome.tabs.create({ url: previewSrc });
      } else {
        window.open(previewSrc, "_blank", "noopener,noreferrer");
      }
      return;
    }
    if (!chrome?.runtime?.getURL) return;
    const url = new URL(chrome.runtime.getURL("image-viewer.html"));
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("ref", previewRefId);
    url.searchParams.set("title", previewRefId || previewAlt || "图片预览");
    if (chrome?.tabs?.create) {
      await chrome.tabs.create({ url: url.href });
    } else {
      window.open(url.href, "_blank", "noopener,noreferrer");
    }
  }

  function savePreviewImage() {
    const imageSrc = String(previewSrc || "");
    if (!imageSrc) return;
    const anchor = document.createElement("a");
    anchor.href = imageSrc;
    anchor.download = getPreviewImageFilename();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
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
            onDoubleClick={handleRefClick}
          />
        )}
        {!isPendingSessionImage && (canPreviewImage || editable) && (
          <span className="chat-image-actions">
            {canPreviewImage && (
              <button
                type="button"
                className="chat-image-ref-btn"
                onClick={handleRefClick}
                title={previewButtonTitle}
                aria-label={previewButtonTitle}
              >
                {previewButtonLabel}
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
      {isPreviewOpen && !isPendingSessionImage && previewSrc && (
        <div
          className="chat-image-preview-backdrop"
          onClick={() => setIsPreviewOpen(false)}
        >
          <div
            className="chat-image-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={previewRefId ? `${previewRefId} 图片预览` : "图片预览"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="chat-image-preview-toolbar">
              <div className="chat-image-preview-title">{previewRefId || previewAlt || "图片预览"}</div>
              <div className="chat-image-preview-controls">
                <div className="chat-image-preview-control-row">
                  <div className="chat-image-preview-zoom-pair">
                    <button type="button" className="chat-image-preview-btn chat-image-preview-btn-compact chat-image-preview-btn-zoom-out" onClick={() => zoomBy(-0.2)} aria-label="缩小图片">-</button>
                    <button type="button" className="chat-image-preview-btn chat-image-preview-btn-compact chat-image-preview-btn-zoom-in" onClick={() => zoomBy(0.2)} aria-label="放大图片">+</button>
                  </div>
                  <button type="button" className="chat-image-preview-btn" onClick={fitPreviewToWindow} aria-label="适应窗口">适应</button>
                  <button type="button" className="chat-image-preview-btn" onClick={showOriginalSize} aria-label="原图大小">100%</button>
                </div>
                <div className="chat-image-preview-control-row">
                  {canOpenInNewTab ? (
                    <button type="button" className="chat-image-preview-btn" onClick={openPreviewInNewTab} aria-label="在新标签中打开图片">新开</button>
                  ) : (
                    <span className="chat-image-preview-btn-placeholder" aria-hidden="true" />
                  )}
                  <button type="button" className="chat-image-preview-btn" onClick={savePreviewImage} aria-label="保存图片">保存</button>
                  <button type="button" className="chat-image-preview-btn" onClick={() => setIsPreviewOpen(false)} aria-label="关闭图片预览">关闭</button>
                </div>
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
              {(previewRefNavigation.prev || previewRefNavigation.next) && (
                <>
                  {previewRefNavigation.prev && (
                    <button
                      type="button"
                      className="chat-image-preview-nav chat-image-preview-nav-prev"
                      onPointerDown={stopPreviewNavPointer}
                      onPointerMove={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); navigatePreviewImage("prev"); }}
                      aria-label="预览上一张 ref 图片"
                    >
                      ‹
                    </button>
                  )}
                  {previewRefNavigation.next && (
                    <button
                      type="button"
                      className="chat-image-preview-nav chat-image-preview-nav-next"
                      onPointerDown={stopPreviewNavPointer}
                      onPointerMove={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); navigatePreviewImage("next"); }}
                      aria-label="预览下一张 ref 图片"
                    >
                      ›
                    </button>
                  )}
                </>
              )}
              <img
                ref={previewImageRef}
                src={previewSrc}
                alt={previewAlt}
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

function inferImageExtension(src) {
  const raw = String(src || "");
  const dataUrlMatch = raw.match(/^data:image\/([^;,]+)/i);
  if (dataUrlMatch) {
    const type = dataUrlMatch[1].toLowerCase();
    if (type === "jpeg") return "jpg";
    if (/^[a-z0-9]+$/.test(type)) return type;
  }
  try {
    const path = new URL(raw, window.location.href).pathname;
    const match = path.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch {
    // Keep the default when the source is not URL-like.
  }
  return "png";
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
  if (key === "src" && node?.tagName === "audio") {
    return normalizeMarkdownAudioSrc(value);
  }
  return defaultUrlTransform(value);
}

function normalizeMarkdownAudioSrc(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";

  try {
    const resolved = new URL(raw, window.location.href);
    if (["http:", "https:"].includes(resolved.protocol)) {
      return resolved.href;
    }
  } catch {
    return "";
  }

  return "";
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
