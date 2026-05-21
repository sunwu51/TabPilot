/* global chrome */
import { textComplete, getLLMConfigForMemory } from "../llm/providers/textComplete";
import { loadSession } from "./sessions";

const MIN_SESSION_KEYWORD_CHARS = 100;
const MAX_SESSION_KEYWORD_SOURCE_CHARS = 12000;
const MAX_KEYWORD_CHARS = 10;
const KEYWORD_COUNT_MAX = 3;

export function getSessionKeywordTextStats(messages, startIndex = 0) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const from = Math.max(0, Number(startIndex) || 0);
  const parts = [];
  let charCount = 0;
  let lastTextMessageIndex = -1;

  for (let i = from; i < safeMessages.length; i++) {
    const msg = safeMessages[i];
    const text = getKeywordSearchableMessageText(msg);
    if (!text) continue;
    parts.push(`${msg.role === "user" ? "用户" : "助手"}：${text}`);
    charCount += countChars(text);
    lastTextMessageIndex = i;
  }

  let text = parts.join("\n\n");
  if (text.length > MAX_SESSION_KEYWORD_SOURCE_CHARS) {
    text = text.slice(-MAX_SESSION_KEYWORD_SOURCE_CHARS);
  }

  return { text, charCount, lastTextMessageIndex };
}

export async function refreshSessionKeywords(sessionId, messages) {
  const safeSessionId = String(sessionId || "").trim();
  if (!safeSessionId || !Array.isArray(messages)) return { updated: false, reason: "invalid_session" };

  const { entry, index } = await getSessionIndexEntry(safeSessionId);
  if (!entry) return { updated: false, reason: "missing_session" };

  const rawExistingKeywords = Array.isArray(entry.keywords || entry.sessionKeywords) ? (entry.keywords || entry.sessionKeywords) : [];
  const existingHasOverlongKeyword = hasOverlongKeyword(rawExistingKeywords);
  const existingKeywords = normalizeKeywords(rawExistingKeywords, { rejectOverlong: false });
  const existingMessageIndex = Number.isInteger(entry.keywordMessageIndex)
    ? entry.keywordMessageIndex
    : (Number.isInteger(entry.keywordsMessageIndex) ? entry.keywordsMessageIndex : -1);

  if (existingKeywords.length > 0 && !existingHasOverlongKeyword && existingKeywords.length !== (entry.keywords || []).length) {
    await updateSessionKeywordEntry(safeSessionId, index, entry, {
      keywords: existingKeywords,
      keywordMessageIndex: existingMessageIndex,
      keywordUpdatedAt: entry.keywordUpdatedAt || Date.now()
    });
  }

  if (!existingHasOverlongKeyword && existingMessageIndex >= messages.length - 1 && existingKeywords.length > 0) {
    return { updated: false, reason: "already_current" };
  }

  const lastMessageIndex = Math.max(0, messages.length - 1);
  const hasValidExistingPointer = !existingHasOverlongKeyword && existingKeywords.length > 0 && existingMessageIndex >= 0 && existingMessageIndex < messages.length;
  const stats = hasValidExistingPointer
    ? getSessionKeywordTextStats(messages, existingMessageIndex + 1)
    : getSessionKeywordTextStats(messages, 0);

  if (stats.charCount <= MIN_SESSION_KEYWORD_CHARS) {
    return { updated: false, reason: "too_short", charCount: stats.charCount };
  }

  const config = await getLLMConfigForMemory();
  if (!config) return { updated: false, reason: "missing_llm_config" };

  const keywords = await generateSessionKeywords(config, {
    previousKeywords: hasValidExistingPointer ? existingKeywords : [],
    conversationText: stats.text
  });
  if (keywords.error) return { updated: false, reason: keywords.error };
  if (keywords.items.length === 0) return { updated: false, reason: "empty_keywords" };

  await updateSessionKeywordEntry(safeSessionId, index, entry, {
    keywords: keywords.items,
    keywordMessageIndex: lastMessageIndex,
    keywordUpdatedAt: Date.now()
  });
  return { updated: true, keywords: keywords.items, keywordMessageIndex: lastMessageIndex };
}

async function updateSessionKeywordEntry(sessionId, index, entry, patch) {
  const nextEntry = {
    ...entry,
    ...patch
  };
  const nextIndex = [...index];
  const targetIndex = nextIndex.findIndex(s => s.id === sessionId);
  if (targetIndex < 0) return false;
  nextIndex[targetIndex] = nextEntry;
  await chrome.storage.local.set({ sessions_index: nextIndex });
  return true;
}

export async function refreshStoredSessionKeywords(sessionId) {
  const messages = await loadSession(sessionId);
  return refreshSessionKeywords(sessionId, messages);
}

async function getSessionIndexEntry(sessionId) {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const index = Array.isArray(sessions_index) ? sessions_index : [];
  const entry = index.find(s => s?.id === sessionId) || null;
  return { entry, index };
}

async function generateSessionKeywords(config, { previousKeywords, conversationText }) {
  const previous = normalizeKeywords(previousKeywords, { rejectOverlong: false });
  const userContent = previous.length > 0
    ? `【已有关键词】${previous.join("、")}\n\n【新增会话内容】\n${conversationText}`
    : `【会话内容】\n${conversationText}`;

  const output = await textComplete(config, [
    {
      role: "system",
      content:
        "你是一个会话关键词提取器。请根据会话内容提炼 3 到 5 个关键词，用于在历史会话列表里做小号 badge 展示。" +
        "关键词要短，优先 2 到 6 个字符，最多不超过 10 个字符。不要包含工具调用、函数名、JSON 或无关实现细节。" +
        "如果提供了已有关键词，请结合新增内容更新为一组更贴切的关键词。" +
        "只输出 JSON 字符串数组，例如：[\"前端调试\",\"旅行计划\",\"报错排查\"]，不要输出解释。"
    },
    { role: "user", content: userContent }
  ], { allowEmptyResponse: true });

  return normalizeGeneratedKeywords(parseKeywordOutput(output));
}

function getKeywordSearchableMessageText(message) {
  if (!message) return "";
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return "";
  if (Array.isArray(message.content) && message.content.some(block => block?.type === "tool_use" || block?.type === "tool_result")) {
    return "";
  }
  return extractPlainTextFromContent(message.content);
}

function extractPlainTextFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (typeof block === "string") return block;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "file" && typeof block.text === "string") return `[附件 ${block.fileName || "file"}]\n${block.text}`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseKeywordOutput(output) {
  const text = String(output || "").trim();
  if (!text) return [];

  const jsonText = extractJsonArrayText(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fallback below
    }
  }

  return text
    .split(/[\n,，、;；|]+/)
    .map(item => item.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
}

function extractJsonArrayText(text) {
  if (text.startsWith("```")) {
    const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (withoutFence.startsWith("[") && withoutFence.includes("]")) return withoutFence;
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return "";
}

function normalizeGeneratedKeywords(keywords) {
  const result = [];
  const seen = new Set();
  let firstKeyword = "";

  for (const raw of Array.isArray(keywords) ? keywords : []) {
    const keyword = cleanKeyword(raw);
    if (!keyword) continue;
    if (!firstKeyword) firstKeyword = keyword;
    if (countChars(keyword) > MAX_KEYWORD_CHARS) continue;

    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length >= KEYWORD_COUNT_MAX) break;
  }

  if (result.length > 0) return { items: result };
  if (!firstKeyword) return { items: [] };
  return { items: [Array.from(firstKeyword).slice(0, MAX_KEYWORD_CHARS).join("")] };
}

function normalizeKeywords(keywords, options = {}) {
  const result = [];
  const seen = new Set();
  const rejectOverlong = options.rejectOverlong === true;
  for (const raw of Array.isArray(keywords) ? keywords : []) {
    let keyword = cleanKeyword(raw);
    if (!keyword) continue;
    if (countChars(keyword) > MAX_KEYWORD_CHARS) {
      if (rejectOverlong) return { error: "overlong_keyword" };
      keyword = Array.from(keyword).slice(0, MAX_KEYWORD_CHARS).join("");
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length >= KEYWORD_COUNT_MAX) break;
  }
  return result;
}

function cleanKeyword(raw) {
  let keyword = String(raw || "").trim();
  keyword = keyword.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
  keyword = keyword.replace(/\s+/g, " ");
  return keyword;
}

function hasOverlongKeyword(keywords) {
  if (!Array.isArray(keywords)) return false;
  return keywords.some(keyword => countChars(keyword) > MAX_KEYWORD_CHARS);
}

function countChars(text) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length;
}
