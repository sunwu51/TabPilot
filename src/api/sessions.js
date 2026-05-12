/* global chrome */

const DEFAULT_NEW_SESSION_SYSTEM_PROMPT_KEY = "agent_default_new_session_system_prompt";
const LAST_ACTIVE_SESSION_ID_KEY = "agent_last_active_session_id";

/**
 * Generate a unique session ID: s_{timestamp}_{random4chars}
 * @returns {string}
 */
export function generateSessionId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  return `s_${ts}_${rand}`;
}

/**
 * Get the sessions index list, sorted by startedAt descending (most recent first).
 * Falls back to updatedAt for legacy sessions without startedAt.
 * @returns {Promise<Array<{id: string, title: string, createdAt: number, updatedAt: number, startedAt: number}>>}
 */
export async function listSessions() {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  return sessions_index.sort((a, b) => (b.startedAt || b.updatedAt) - (a.startedAt || a.updatedAt));
}

/**
 * Load the session ID that was last being viewed in the assistant panel.
 * @returns {Promise<string>}
 */
export async function loadLastActiveSessionId() {
  const result = await chrome.storage.local.get({ [LAST_ACTIVE_SESSION_ID_KEY]: "" });
  return typeof result[LAST_ACTIVE_SESSION_ID_KEY] === "string" ? result[LAST_ACTIVE_SESSION_ID_KEY] : "";
}

/**
 * Persist the session ID that is currently being viewed in the assistant panel.
 * @param {string} id - session ID
 */
export async function saveLastActiveSessionId(id) {
  const normalizedId = typeof id === "string" ? id : "";
  if (!normalizedId) {
    await chrome.storage.local.remove(LAST_ACTIVE_SESSION_ID_KEY);
    return "";
  }
  await chrome.storage.local.set({ [LAST_ACTIVE_SESSION_ID_KEY]: normalizedId });
  return normalizedId;
}

/**
 * Create a new session entry in the index. Does NOT save messages yet.
 * @param {string} id - session ID
 * @param {string} title - display title
 */
export async function createSession(id, title) {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const now = Date.now();
  sessions_index.unshift({
    id,
    title: title || "新会话",
    createdAt: now,
    updatedAt: now,
    startedAt: 0,
    manualTitle: false
  });
  await chrome.storage.local.set({ sessions_index });
}

/**
 * Load messages for a specific session.
 * @param {string} id - session ID
 * @returns {Promise<Array>} messages array (empty if session not found)
 */
export async function loadSession(id) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { messages: [] } });
  return result[key].messages;
}

/**
 * Load optional metadata for a specific session.
 * @param {string} id - session ID
 * @returns {Promise<{systemPrompt: string, plans: Array}>}
 */
export async function loadSessionMeta(id) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { messages: [], systemPrompt: "", plans: [] } });
  return {
    systemPrompt: result[key]?.systemPrompt || "",
    plans: Array.isArray(result[key]?.plans) ? result[key].plans : []
  };
}

/**
 * Save messages for a session and update the index entry (title + updatedAt).
 * @param {string} id - session ID
 * @param {Array} messages - full message history
 * @param {string} [title] - updated title (auto-generated from first user message)
 */
export async function saveSession(id, messages, title) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: {} });
  await chrome.storage.local.set({ [key]: { ...result[key], messages } });

  // Update index entry
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (entry) {
    if (title && !entry.manualTitle) entry.title = title;
    if (!entry.startedAt && messages && messages.length > 0) entry.startedAt = Date.now();
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index });
}

/**
 * Update a session title manually. Manual titles are not overwritten by auto-generated titles.
 * @param {string} id - session ID
 * @param {string} title - custom display title
 */
export async function updateSessionTitle(id, title) {
  const normalizedTitle = String(title || "").trim() || "新会话";
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (entry) {
    entry.title = normalizedTitle;
    entry.manualTitle = true;
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index });
  return normalizedTitle;
}

/**
 * Reset a session title back to the automatic-title mode.
 * @param {string} id - session ID
 * @param {string} [title] - display title to use until the next auto-generated title
 */
export async function resetSessionTitle(id, title = "新会话") {
  const normalizedTitle = String(title || "").trim() || "新会话";
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (entry) {
    entry.title = normalizedTitle;
    entry.manualTitle = false;
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index });
  return normalizedTitle;
}

/**
 * Save optional metadata for a session without replacing messages.
 * @param {string} id - session ID
 * @param {{systemPrompt?: string, plans?: Array}} meta - partial session metadata
 */
export async function saveSessionMeta(id, meta = {}) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { messages: [] } });
  await chrome.storage.local.set({
    [key]: {
      ...result[key],
      ...meta
    }
  });

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (entry) {
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index });
}

/**
 * Delete a session: remove from index and delete stored messages.
 * @param {string} id - session ID
 */
export async function deleteSession(id) {
  const key = `session_${id}`;
  const lastActiveSessionId = await loadLastActiveSessionId();
  const keysToRemove = lastActiveSessionId === id ? [key, LAST_ACTIVE_SESSION_ID_KEY] : key;
  await chrome.storage.local.remove(keysToRemove);

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const updated = sessions_index.filter(s => s.id !== id);
  await chrome.storage.local.set({ sessions_index: updated });
}

/**
 * Load the system prompt that should be copied into newly-created sessions.
 * @returns {Promise<{sessionId: string, systemPrompt: string}>}
 */
export async function loadDefaultNewSessionSystemPrompt() {
  const result = await chrome.storage.local.get({
    [DEFAULT_NEW_SESSION_SYSTEM_PROMPT_KEY]: { sessionId: "", systemPrompt: "" }
  });
  const value = result[DEFAULT_NEW_SESSION_SYSTEM_PROMPT_KEY] || {};
  return {
    sessionId: value.sessionId || "",
    systemPrompt: value.systemPrompt || ""
  };
}

/**
 * Save or clear the system prompt that should be copied into newly-created sessions.
 * @param {{sessionId?: string, systemPrompt?: string}} value
 */
export async function saveDefaultNewSessionSystemPrompt(value = {}) {
  const normalizedPrompt = String(value.systemPrompt || "").trim();
  if (!normalizedPrompt) {
    await chrome.storage.local.set({
      [DEFAULT_NEW_SESSION_SYSTEM_PROMPT_KEY]: { sessionId: "", systemPrompt: "" }
    });
    return { sessionId: "", systemPrompt: "" };
  }
  const next = {
    sessionId: value.sessionId || "",
    systemPrompt: normalizedPrompt
  };
  await chrome.storage.local.set({ [DEFAULT_NEW_SESSION_SYSTEM_PROMPT_KEY]: next });
  return next;
}

/**
 * Extract a title from messages: first user message content, truncated to 20 chars.
 * @param {Array} messages
 * @returns {string}
 */
export function extractTitle(messages) {
  const firstUser = messages.find(m => m.role === "user" && typeof m.content === "string");
  if (!firstUser) return "新会话";
  const text = firstUser.content.trim();
  return text.length > 20 ? text.substring(0, 20) + "..." : text;
}
