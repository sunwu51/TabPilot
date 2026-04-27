import { useMemo, useState } from "react";
import ChatMessage from "./ChatMessage";

export default function ChatMessageList({ messages = [], onRewindToUserMessage }) {
  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <>
      {groups.map((group, groupIndex) => {
        if (group.type === "tools") {
          return (
            <CollapsedToolGroup
              key={group.key || `tools-${groupIndex}`}
              messages={group.messages}
              startIndex={group.startIndex}
              onRewindToUserMessage={onRewindToUserMessage}
            />
          );
        }
        return (
          <ChatMessage
            key={group.key || `msg-${group.index}`}
            msg={group.message}
            messageIndex={group.index}
            onRewindToUserMessage={onRewindToUserMessage}
          />
        );
      })}
    </>
  );
}

function CollapsedToolGroup({ messages, startIndex, onRewindToUserMessage }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;

  return (
    <div className="tool-result-msg tool-group-msg">
      <div className="tool-result-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-result-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="tool-result-label">展开查看 {count} 个工具调用详情</span>
      </div>
      {expanded && (
        <div className="tool-group-content">
          {messages.map((msg, offset) => (
            <ChatMessage
              key={offset}
              msg={msg}
              messageIndex={startIndex + offset}
              onRewindToUserMessage={onRewindToUserMessage}
            />
          ))}
        </div>
      )}
    </div>
  );
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

    if (group.length >= 2) {
      result.push({ type: "tools", messages: group, startIndex: start, key: `tools-${start}-${group.length}` });
    } else {
      result.push({ type: "message", message: group[0], index: start, key: `msg-${start}` });
    }
  }

  return result;
}

function isToolLikeMessage(message) {
  if (!message || message.__streaming) return false;
  if (message.role === "tool") return true;
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content.some((block) => block?.type === "tool_use");
  }
  return false;
}

