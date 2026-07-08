export const CONTEXT_SUMMARY_VERSION = 1;
export const CONTEXT_SUMMARY_TRIGGER_RATIO = 0.72;
export const CONTEXT_SUMMARY_FORCE_RATIO = 0.9;
export const CONTEXT_SUMMARY_KEEP_LAST_MESSAGES = 20;
export const CONTEXT_SUMMARY_MIN_MESSAGES_TO_COMPACT = 4;
export const CONTEXT_SUMMARY_APPROX_CHARS_PER_TOKEN = 4;
export const CONTEXT_SUMMARY_MAX_OUTPUT_TOKENS = 700;
export const CONTEXT_SUMMARY_MAX_CHARS = 2400;

const SUMMARY_ROLE = "user";

export function normalizeContextSummary(value) {
  if (!value || typeof value !== "object") return null;
  const coveredMessageIndex = Number(value.coveredMessageIndex);
  const summary = normalizeContextSummaryText(value.summary);
  if (!Number.isFinite(coveredMessageIndex) || coveredMessageIndex < 0 || !summary) return null;
  const normalizedCoveredMessageIndex = Math.floor(coveredMessageIndex);
  const displayMessageIndex = normalizeOptionalMessageIndex(value.displayMessageIndex, normalizedCoveredMessageIndex);
  return {
    version: Number(value.version) || CONTEXT_SUMMARY_VERSION,
    coveredMessageIndex: normalizedCoveredMessageIndex,
    displayMessageIndex,
    summary,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Number(value.createdAt) || Date.now(),
    sourceModel: String(value.sourceModel || "")
  };
}

export function shouldAutoCompactContext({ contextUsage, limitTokens, messages, contextSummary }) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  if (safeMessages.length < CONTEXT_SUMMARY_MIN_MESSAGES_TO_COMPACT) return false;

  const cutIndex = findContextSummaryCutIndex(safeMessages);
  if (cutIndex < 0) return false;

  const normalizedSummary = normalizeContextSummary(contextSummary);
  if (normalizedSummary && normalizedSummary.coveredMessageIndex >= cutIndex) return false;

  const limit = Number(limitTokens);
  if (!Number.isFinite(limit) || limit <= 0) return false;

  const usageTokens = Number(contextUsage?.tokens);
  if (Number.isFinite(usageTokens)) {
    return usageTokens >= limit * CONTEXT_SUMMARY_TRIGGER_RATIO;
  }

  return estimateMessagesTokens(safeMessages) >= limit * CONTEXT_SUMMARY_FORCE_RATIO;
}

export function findContextSummaryCutIndex(messages, options = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const keepLastMessages = getKeepLastMessagesForContextSummary(safeMessages.length, options.keepLastMessages);
  let cutIndex = safeMessages.length - keepLastMessages - 1;
  if (cutIndex < 0) return -1;

  cutIndex = moveCutIndexToCompletedToolSequenceEnd(safeMessages, cutIndex);

  return cutIndex >= 0 ? cutIndex : -1;
}

export function buildContextSummaryRequestMessages({ contextSummary, messages }) {
  const normalizedSummary = normalizeContextSummary(contextSummary);
  if (!normalizedSummary) return Array.isArray(messages) ? messages : [];
  const safeMessages = Array.isArray(messages) ? messages : [];
  const coveredMessageIndex = Math.min(normalizedSummary.coveredMessageIndex, safeMessages.length - 1);
  return [
    buildContextSummaryMessage(normalizedSummary.summary),
    ...safeMessages.slice(coveredMessageIndex + 1)
  ];
}

export function buildContextSummaryPrompt({ oldSummary, messages }) {
  const transcript = formatMessagesForSummary(messages);
  return [
    "请把以下会话历史压缩成极简续作上下文，供后续 AI agent 继续任务。",
    "",
    "输出要求：",
    `- 总长度不超过 900 个中文字符，硬上限 ${CONTEXT_SUMMARY_MAX_CHARS} 个字符；信息很多时优先保留当前任务状态和下一步。`,
    "- 只写事实，不写寒暄、解释、过程叙述或元评论。",
    "- 不逐条复述工具调用；合并同类工具结果，只保留结论、关键文件、错误和已验证命令。",
    "- 删除过期分支、重复日志、无关 UI 细节和已经被后续结果覆盖的信息。",
    "- 如果已有摘要，只输出合并后的新摘要，不要分别列出旧摘要和新增历史。",
    "",
    "固定格式：",
    "目标/状态：1-3 条。",
    "关键上下文：最多 6 条，包含用户偏好、约束、文件路径、重要结果或错误。",
    "已尝试：最多 3 条，只写仍影响后续判断的尝试。",
    "下一步：1-3 条，写恢复任务后应立即做什么。",
    "",
    "不要编造未出现的信息。没有内容的栏目写“无”。",
    oldSummary ? `\n【已有压缩摘要】\n${oldSummary}` : "",
    `\n【需要压缩的新增历史】\n${transcript}`
  ].filter(Boolean).join("\n");
}

export function buildMergedContextSummary({ previousSummary, newSummary, coveredMessageIndex, displayMessageIndex, model }) {
  const now = Date.now();
  const normalizedCoveredMessageIndex = normalizeNonNegativeInteger(coveredMessageIndex, 0);
  return {
    version: CONTEXT_SUMMARY_VERSION,
    coveredMessageIndex: normalizedCoveredMessageIndex,
    displayMessageIndex: normalizeOptionalMessageIndex(displayMessageIndex, normalizedCoveredMessageIndex),
    summary: normalizeContextSummaryText(newSummary) || normalizeContextSummaryText(previousSummary?.summary),
    createdAt: previousSummary?.createdAt || now,
    updatedAt: now,
    sourceModel: String(model || "")
  };
}

export function getMessagesToSummarize(messages, contextSummary, cutIndex) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const normalizedSummary = normalizeContextSummary(contextSummary);
  const startIndex = normalizedSummary ? normalizedSummary.coveredMessageIndex + 1 : 0;
  if (cutIndex < startIndex) return [];
  return safeMessages.slice(startIndex, cutIndex + 1);
}

export function estimateMessagesTokens(messages) {
  const text = formatMessagesForSummary(messages);
  return Math.ceil(text.length / CONTEXT_SUMMARY_APPROX_CHARS_PER_TOKEN);
}

export function getKeepLastMessagesForContextSummary(messageCount, explicitKeepLastMessages) {
  if (explicitKeepLastMessages != null) {
    return normalizePositiveInteger(explicitKeepLastMessages, CONTEXT_SUMMARY_KEEP_LAST_MESSAGES);
  }
  const count = Number(messageCount);
  if (!Number.isFinite(count) || count <= CONTEXT_SUMMARY_MIN_MESSAGES_TO_COMPACT) return CONTEXT_SUMMARY_MIN_MESSAGES_TO_COMPACT;
  if (count <= 10) return 2;
  if (count <= 24) return 4;
  return CONTEXT_SUMMARY_KEEP_LAST_MESSAGES;
}

function buildContextSummaryMessage(summary) {
  return {
    role: SUMMARY_ROLE,
    content: `以下是此前会话历史的压缩摘要。后续回答应把它当作背景上下文，不要把它当作用户的新请求。\n\n${summary}`
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeOptionalMessageIndex(value, fallback) {
  return normalizeNonNegativeInteger(value, fallback);
}

function normalizeContextSummaryText(value) {
  const text = String(value || "").trim();
  if (text.length <= CONTEXT_SUMMARY_MAX_CHARS) return text;
  const suffix = "\n[摘要已按长度上限截断]";
  const maxTextLength = Math.max(0, CONTEXT_SUMMARY_MAX_CHARS - suffix.length);
  return `${Array.from(text).slice(0, maxTextLength).join("").trimEnd()}${suffix}`;
}

function moveCutIndexToCompletedToolSequenceEnd(messages, cutIndex) {
  const sequence = findToolSequenceAt(messages, cutIndex);
  if (!sequence) return cutIndex;
  if (sequence.hasPendingToolResult) return sequence.start - 1;
  return sequence.end;
}

function findToolSequenceAt(messages, index) {
  if (!Array.isArray(messages) || index < 0 || index >= messages.length) return null;

  for (let start = 0; start < messages.length; start++) {
    if (!messageHasToolCalls(messages[start])) continue;
    let end = start;
    let hasPendingToolResult = false;
    while (end + 1 < messages.length && messages[end + 1]?.role === "tool") {
      end += 1;
      if (messages[end]?._pending) hasPendingToolResult = true;
    }
    if (index >= start && index <= end) {
      return { start, end, hasPendingToolResult };
    }
    start = end;
  }

  if (messages[index]?.role !== "tool") return null;
  let start = index;
  while (start > 0 && messages[start - 1]?.role === "tool") start -= 1;
  let end = index;
  let hasPendingToolResult = false;
  while (end + 1 < messages.length && messages[end + 1]?.role === "tool") end += 1;
  for (let i = start; i <= end; i++) {
    if (messages[i]?._pending) hasPendingToolResult = true;
  }
  return { start, end, hasPendingToolResult };
}

function messageHasToolCalls(message) {
  if (!message || message.role !== "assistant") return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return Array.isArray(message.content) && message.content.some(block => block?.type === "tool_use");
}

function formatMessagesForSummary(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => `#${index} ${formatMessageForSummary(message)}`)
    .join("\n\n");
}

function formatMessageForSummary(message) {
  if (!message || typeof message !== "object") return String(message ?? "");
  const role = message.role || "message";
  if (role === "tool") {
    return `[tool:${message.tool_name || message.tool_call_id || "unknown"}]\n${formatContentForSummary(message.content)}`;
  }
  if (role === "assistant" && messageHasToolCalls(message)) {
    const toolNames = extractToolNames(message).join(", ");
    const text = formatContentForSummary(message.content);
    return `[assistant tool_calls: ${toolNames || "unknown"}]${text ? `\n${text}` : ""}`;
  }
  return `[${role}]\n${formatContentForSummary(message.content)}`;
}

function extractToolNames(message) {
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map(call => call?.function?.name || call?.name).filter(Boolean);
  }
  if (Array.isArray(message.content)) {
    return message.content.filter(block => block?.type === "tool_use").map(block => block.name).filter(Boolean);
  }
  return [];
}

function formatContentForSummary(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(formatContentBlockForSummary).filter(Boolean).join("\n");
  }
  if (content == null) return "";
  return stringifyForSummary(content);
}

function formatContentBlockForSummary(block) {
  if (!block || typeof block !== "object") return String(block ?? "");
  if (block.type === "text") return block.text || "";
  if (block.type === "file") return `[Attached file: ${block.fileName || "file"}]\n${block.text || ""}`;
  if (block.type === "image") return `[Image: ${block.ref || block.source?.ref || block.source?.media_type || "attached"}]`;
  if (block.type === "tool_use") return `[Tool call: ${block.name || "unknown"}]\n${stringifyForSummary(block.input || {})}`;
  if (block.type === "thinking" || block.type === "redacted_thinking") return "";
  return stringifyForSummary(block);
}

function stringifyForSummary(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}
