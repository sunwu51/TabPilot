export function buildGlobalSessionSearchResult(sessionEntry, messages, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!sessionEntry || !normalizedQuery) return null;
  let hitCount = 0;
  let firstSnippet = "";
  let lastMessageTime = null;
  for (const message of messages || []) {
    if (!isGlobalSearchableMessage(message)) continue;
    const timestamp = message.sentAt || message.completedAt || message.updatedAt || null;
    if (timestamp && (!lastMessageTime || timestamp > lastMessageTime)) lastMessageTime = timestamp;
    const text = getGlobalSearchableMessageText(message);
    if (!text) continue;
    const lowerText = text.toLowerCase();
    let fromIndex = 0;
    while (fromIndex < lowerText.length) {
      const foundAt = lowerText.indexOf(normalizedQuery, fromIndex);
      if (foundAt < 0) break;
      hitCount += 1;
      if (!firstSnippet) firstSnippet = buildSearchSnippet(text, foundAt, normalizedQuery.length);
      fromIndex = foundAt + Math.max(1, normalizedQuery.length);
    }
  }
  if (hitCount === 0) return null;
  return {
    sessionId: sessionEntry.id,
    title: sessionEntry.title || "新会话",
    startedAt: sessionEntry.startedAt || 0,
    updatedAt: sessionEntry.updatedAt || 0,
    lastMessageTime,
    hitCount,
    snippet: firstSnippet || "命中当前关键词"
  };
}
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isGlobalSearchableMessage(message) {
  if (!message) return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  if (Array.isArray(message.content) && message.content.some(block => block?.type === "tool_use" || block?.type === "tool_result")) {
    return false;
  }
  return true;
}

export function getGlobalSearchableMessageText(message) {
  const { content } = message || {};
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (typeof block === "string") return block;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildSearchSnippet(text, hitStart, queryLength) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const safeStart = Math.max(0, Math.min(source.length, hitStart));
  const start = Math.max(0, safeStart - 36);
  const end = Math.min(source.length, safeStart + queryLength + 56);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}
