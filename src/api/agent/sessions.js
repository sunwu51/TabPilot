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
 * Load the image store for a session. Kept separate from messages so large base64
 * images do not block session switching.
 * @param {string} id - session ID
 * @returns {Promise<object>} image store keyed by image ref
 */
export async function loadSessionImageStore(id) {
  const key = getSessionImageStoreKey(id);
  const result = await chrome.storage.local.get({ [key]: {} });
  return result[key] && typeof result[key] === "object" ? result[key] : {};
}

/**
 * Load messages and hydrate out-of-band image refs. Use only when the caller
 * explicitly needs base64 image payloads synchronously.
 * @param {string} id - session ID
 * @returns {Promise<Array>} hydrated messages array
 */
export async function loadHydratedSession(id) {
  const [messages, imageStore] = await Promise.all([
    loadSession(id),
    loadSessionImageStore(id)
  ]);
  return hydrateSessionMessages(messages, imageStore);
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
  const { messages: compactMessages, imageStore } = compactSessionMessages(messages);
  const imageStoreKey = getSessionImageStoreKey(id);
  await chrome.storage.local.set({
    [key]: { ...result[key], messages: compactMessages },
    [imageStoreKey]: imageStore || {}
  });

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

const SESSION_IMAGE_STORE_REF_PREFIX = "session-image:";

function getSessionImageStoreKey(id) {
  return `session_${id}_images`;
}

export function compactSessionMessages(messages) {
  if (!Array.isArray(messages)) return { messages, imageStore: undefined };
  const imageStore = {};
  const byValue = new Map();
  let nextIndex = 1;

  function storeDataUrl(dataUrl, preferredKey = "") {
    const raw = String(dataUrl || "");
    if (!isBase64DataUrl(raw)) return raw;
    const existing = byValue.get(raw);
    if (existing) return `${SESSION_IMAGE_STORE_REF_PREFIX}${existing}`;

    let key = normalizeImageStoreKey(preferredKey);
    while (!key || Object.prototype.hasOwnProperty.call(imageStore, key)) {
      key = `img_${nextIndex}`;
      nextIndex += 1;
    }
    imageStore[key] = raw;
    byValue.set(raw, key);
    return `${SESSION_IMAGE_STORE_REF_PREFIX}${key}`;
  }

  function storeImageBlockSource(source, preferredKey = "") {
    if (!source || typeof source !== "object") return source;
    if (source.type !== "base64" || !source.media_type || !source.data) return compactValue(source, preferredKey);
    const ref = storeDataUrl(`data:${source.media_type};base64,${source.data}`, preferredKey);
    const imageRef = ref.startsWith(SESSION_IMAGE_STORE_REF_PREFIX)
      ? ref.slice(SESSION_IMAGE_STORE_REF_PREFIX.length)
      : "";
    return imageRef
      ? { type: "session_image", ref: imageRef, media_type: source.media_type }
      : source;
  }

  function compactValue(value, preferredKey = "") {
    if (typeof value === "string") {
      if (preferredKey) return storeDataUrl(value, preferredKey);
      return isBase64DataUrl(value) ? storeDataUrl(value) : value;
    }
    if (Array.isArray(value)) return value.map(item => compactValue(item));
    if (!value || typeof value !== "object") return value;
    if (value.type === "image" && value.source) {
      return {
        ...value,
        source: storeImageBlockSource(value.source, preferredKey)
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        compactValue(child, getImageStorePreferredKeyForChild(key, child, value))
      ])
    );
  }

  const compactMessages = messages.map(message => compactValue(message));
  return {
    messages: compactMessages,
    imageStore: Object.keys(imageStore).length > 0 ? imageStore : undefined
  };
}

export function hydrateSessionMessages(messages, imageStore) {
  if (!Array.isArray(messages) || !imageStore || typeof imageStore !== "object") return messages;

  function hydrateValue(value) {
    if (typeof value === "string") {
      if (!value.startsWith(SESSION_IMAGE_STORE_REF_PREFIX)) return value;
      const key = value.slice(SESSION_IMAGE_STORE_REF_PREFIX.length);
      return imageStore[key] || value;
    }
    if (Array.isArray(value)) return value.map(hydrateValue);
    if (!value || typeof value !== "object") return value;
    if (value.type === "image" && value.source?.type === "session_image") {
      const dataUrl = imageStore[value.source.ref];
      const parsed = parseImageDataUrl(dataUrl);
      if (parsed) {
        return {
          ...value,
          source: { type: "base64", media_type: parsed.mediaType, data: parsed.data }
        };
      }
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, hydrateValue(child)])
    );
  }

  return messages.map(hydrateValue);
}

function normalizeImageStoreKey(value) {
  const raw = String(value || "").trim();
  return /^img_[A-Za-z0-9_-]+$/.test(raw) ? raw : "";
}

function getImageStorePreferredKeyForChild(key, child, parent) {
  if (!isImageDataFieldName(key) || typeof child !== "string") return "";
  return String(parent?.ref || "").trim();
}

function isImageDataFieldName(key) {
  return /^(dataUrl|displayImageUrl|url|source)$/i.test(String(key || ""));
}

function isBase64DataUrl(value) {
  return typeof value === "string" && /^data:[^;]+;base64,/.test(value);
}

function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
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
 * Clear derived keyword fields for a session index entry.
 * @param {string} id - session ID
 */
export async function clearSessionKeywords(id) {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (!entry) return false;

  delete entry.keywords;
  delete entry.sessionKeywords;
  delete entry.keywordMessageIndex;
  delete entry.keywordsMessageIndex;
  delete entry.keywordUpdatedAt;
  entry.updatedAt = Date.now();

  await chrome.storage.local.set({ sessions_index });
  return true;
}

/**
 * Delete a session: remove from index and delete stored messages.
 * @param {string} id - session ID
 */
export async function deleteSession(id) {
  const key = `session_${id}`;
  const lastActiveSessionId = await loadLastActiveSessionId();
  const keysToRemove = [
    key,
    getSessionImageStoreKey(id),
    ...(lastActiveSessionId === id ? [LAST_ACTIVE_SESSION_ID_KEY] : [])
  ];
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
 * Extract a title from messages: first user-visible text, truncated to 20 chars.
 * @param {Array} messages
 * @returns {string}
 */
export function extractTitle(messages) {
  const firstUser = messages.find(m => m.role === "user" && extractUserTitleText(m));
  if (!firstUser) return "新会话";
  const text = extractUserTitleText(firstUser);
  return text.length > 20 ? text.substring(0, 20) + "..." : text;
}

function extractUserTitleText(message) {
  const displayContent = String(message?.displayContent || "").trim();
  if (displayContent) return displayContent;

  if (typeof message?.content === "string") {
    return message.content.trim();
  }

  if (!Array.isArray(message?.content)) return "";

  const textBlock = message.content.find(block => block?.type === "text" && String(block.text || "").trim());
  if (!textBlock) return "";

  return String(textBlock.text || "")
    .split(/\n{2,}Attached image ref:/)[0]
    .trim();
}
