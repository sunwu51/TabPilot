/* global chrome */

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
 * Get the sessions index list, sorted by updatedAt descending (most recent first).
 * @returns {Promise<Array<{id: string, title: string, createdAt: number, updatedAt: number}>>}
 */
export async function listSessions() {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  return sessions_index.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Create a new session entry in the index. Does NOT save messages yet.
 * @param {string} id - session ID
 * @param {string} title - display title
 */
export async function createSession(id, title) {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const now = Date.now();
  sessions_index.unshift({ id, title: title || "新会话", createdAt: now, updatedAt: now });
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
 * @returns {Promise<{systemPrompt: string}>}
 */
export async function loadSessionMeta(id) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { messages: [], systemPrompt: "" } });
  return {
    systemPrompt: result[key]?.systemPrompt || ""
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
    if (title) entry.title = title;
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index });
}

/**
 * Save optional metadata for a session without replacing messages.
 * @param {string} id - session ID
 * @param {{systemPrompt?: string}} meta - partial session metadata
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
  await chrome.storage.local.remove(key);

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const updated = sessions_index.filter(s => s.id !== id);
  await chrome.storage.local.set({ sessions_index: updated });
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
