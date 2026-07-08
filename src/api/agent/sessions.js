/* global chrome */

const DEFAULT_NEW_SESSION_SYSTEM_PROMPT_KEY = "agent_default_new_session_system_prompt";
const LAST_ACTIVE_SESSION_ID_KEY = "agent_last_active_session_id";
const LAST_ACTIVE_SESSION_BY_WINDOW_KEY = "agent_last_active_session_by_window";
const SESSION_LOCKS_KEY = "agent_session_locks";
const SESSION_LOCK_TTL_MS = 30 * 1000;
const CONTEXT_SUMMARY_MAX_CHARS = 2400;

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

export async function loadLastActiveSessionIdForWindow(windowId) {
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedWindowId) return "";
  const result = await chrome.storage.local.get({ [LAST_ACTIVE_SESSION_BY_WINDOW_KEY]: {} });
  const value = result[LAST_ACTIVE_SESSION_BY_WINDOW_KEY];
  return typeof value?.[normalizedWindowId] === "string" ? value[normalizedWindowId] : "";
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

export async function saveLastActiveSessionIdForWindow(windowId, id) {
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedWindowId) return "";
  const normalizedId = typeof id === "string" ? id : "";
  const result = await chrome.storage.local.get({ [LAST_ACTIVE_SESSION_BY_WINDOW_KEY]: {} });
  const next = result[LAST_ACTIVE_SESSION_BY_WINDOW_KEY] && typeof result[LAST_ACTIVE_SESSION_BY_WINDOW_KEY] === "object"
    ? { ...result[LAST_ACTIVE_SESSION_BY_WINDOW_KEY] }
    : {};
  if (normalizedId) {
    next[normalizedWindowId] = normalizedId;
  } else {
    delete next[normalizedWindowId];
  }
  await chrome.storage.local.set({ [LAST_ACTIVE_SESSION_BY_WINDOW_KEY]: next });
  return normalizedId;
}

export async function claimSessionLock(sessionId, windowId, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedSessionId || !normalizedWindowId) {
    return { claimed: false, conflict: null };
  }
  const now = Date.now();
  const locks = await loadSessionLocks();
  const existing = locks[normalizedSessionId];
  const existingWindowId = normalizeWindowId(existing?.windowId);
  if (
    existing &&
    existingWindowId &&
    existingWindowId !== normalizedWindowId &&
    !isSessionLockExpired(existing, now) &&
    !options.force
  ) {
    if (await sessionLockWindowExists(existingWindowId)) {
      return { claimed: false, conflict: { ...existing, sessionId: normalizedSessionId } };
    }
  }
  locks[normalizedSessionId] = { windowId: normalizedWindowId, updatedAt: now };
  await chrome.storage.local.set({ [SESSION_LOCKS_KEY]: locks });
  return { claimed: true, conflict: null };
}

export async function refreshSessionLock(sessionId, windowId) {
  return claimSessionLock(sessionId, windowId, { force: false });
}

export async function releaseSessionLock(sessionId, windowId) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedSessionId || !normalizedWindowId) return;
  const locks = await loadSessionLocks();
  if (normalizeWindowId(locks[normalizedSessionId]?.windowId) === normalizedWindowId) {
    delete locks[normalizedSessionId];
    await chrome.storage.local.set({ [SESSION_LOCKS_KEY]: locks });
  }
}

export async function releaseSessionLocksForWindow(windowId) {
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedWindowId) return 0;
  const locks = await loadSessionLocks();
  let releasedCount = 0;
  for (const [sessionId, lock] of Object.entries(locks)) {
    if (normalizeWindowId(lock?.windowId) === normalizedWindowId) {
      delete locks[sessionId];
      releasedCount += 1;
    }
  }
  if (releasedCount > 0) {
    await chrome.storage.local.set({ [SESSION_LOCKS_KEY]: locks });
  }
  return releasedCount;
}

export async function isSessionLockedByOtherWindow(sessionId, windowId) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedSessionId || !normalizedWindowId) return null;
  const locks = await loadSessionLocks();
  const existing = locks[normalizedSessionId];
  const existingWindowId = normalizeWindowId(existing?.windowId);
  if (
    existing &&
    existingWindowId &&
    existingWindowId !== normalizedWindowId &&
    !isSessionLockExpired(existing)
  ) {
    if (!(await sessionLockWindowExists(existingWindowId))) {
      delete locks[normalizedSessionId];
      await chrome.storage.local.set({ [SESSION_LOCKS_KEY]: locks });
      return null;
    }
    return { ...existing, sessionId: normalizedSessionId };
  }
  return null;
}

export async function pruneExpiredSessionLocks() {
  const locks = await loadSessionLocks();
  const now = Date.now();
  let changed = false;
  for (const [sessionId, lock] of Object.entries(locks)) {
    if (isSessionLockExpired(lock, now) || !(await sessionLockWindowExists(lock?.windowId))) {
      delete locks[sessionId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [SESSION_LOCKS_KEY]: locks });
  return locks;
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
 * @returns {Promise<{systemPrompt: string, plans: Array, nextImageRefIndex: number, contextSummary: object | null, queuedMessages: Array}>}
 */
export async function loadSessionMeta(id) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { messages: [], systemPrompt: "", plans: [], nextImageRefIndex: 1, contextSummary: null, queuedMessages: [] } });
  return {
    systemPrompt: result[key]?.systemPrompt || "",
    plans: Array.isArray(result[key]?.plans) ? result[key].plans : [],
    nextImageRefIndex: normalizeNextImageRefIndex(result[key]?.nextImageRefIndex),
    contextSummary: normalizeStoredContextSummary(result[key]?.contextSummary),
    queuedMessages: normalizeQueuedMessages(result[key]?.queuedMessages)
  };
}

export async function loadSessionQueuedMessages(id) {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { queuedMessages: [] } });
  return normalizeQueuedMessages(result[key]?.queuedMessages);
}

export async function saveSessionQueuedMessages(id, queuedMessages = []) {
  const key = `session_${id}`;
  const imageStoreKey = getSessionImageStoreKey(id);
  const result = await chrome.storage.local.get({ [key]: { messages: [] }, [imageStoreKey]: {} });
  const existingImageStore = result[imageStoreKey] && typeof result[imageStoreKey] === "object"
    ? result[imageStoreKey]
    : {};
  const { messages: compactQueuedMessages, imageStore } = compactSessionMessages(queuedMessages, {
    existingImageStore,
    pruneUnreferencedImageStore: false
  });
  await chrome.storage.local.set({
    [key]: {
      ...result[key],
      queuedMessages: normalizeQueuedMessages(compactQueuedMessages)
    },
    [imageStoreKey]: imageStore || existingImageStore || {}
  });

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (entry) {
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index });
}

function normalizeQueuedMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === "object" && item.role === "user")
    .map((item, index) => ({
      ...item,
      id: String(item.id || `queued_${Date.now()}_${index}`),
      role: "user",
      createdAt: Number(item.createdAt) || Date.now()
    }));
}

function normalizeStoredContextSummary(contextSummary) {
  if (!contextSummary || typeof contextSummary !== "object") return null;
  const summary = normalizeStoredContextSummaryText(contextSummary.summary);
  const coveredMessageIndex = Number(contextSummary.coveredMessageIndex);
  if (!summary || !Number.isFinite(coveredMessageIndex) || coveredMessageIndex < 0) return null;
  const normalizedCoveredMessageIndex = Math.floor(coveredMessageIndex);
  const displayMessageIndex = Number(contextSummary.displayMessageIndex);
  return {
    ...contextSummary,
    summary,
    coveredMessageIndex: normalizedCoveredMessageIndex,
    displayMessageIndex: Number.isFinite(displayMessageIndex) && displayMessageIndex >= 0
      ? Math.floor(displayMessageIndex)
      : normalizedCoveredMessageIndex
  };
}

function normalizeStoredContextSummaryText(value) {
  const text = String(value || "").trim();
  if (text.length <= CONTEXT_SUMMARY_MAX_CHARS) return text;
  const suffix = "\n[摘要已按长度上限截断]";
  const maxTextLength = Math.max(0, CONTEXT_SUMMARY_MAX_CHARS - suffix.length);
  return `${Array.from(text).slice(0, maxTextLength).join("").trimEnd()}${suffix}`;
}

/**
 * Save messages for a session and update the index entry (title + updatedAt).
 * @param {string} id - session ID
 * @param {Array} messages - full message history
 * @param {string} [title] - updated title (auto-generated from first user message)
 * @param {{nextImageRefIndex?: number, contextUsage?: object | null}} [options]
 */
export async function saveSession(id, messages, title, options = {}) {
  const key = `session_${id}`;
  const imageStoreKey = getSessionImageStoreKey(id);
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const entry = sessions_index.find(s => s.id === id);
  if (!entry) return false;

  const result = await chrome.storage.local.get({ [key]: {}, [imageStoreKey]: {} });
  const existingImageStore = result[imageStoreKey] && typeof result[imageStoreKey] === "object"
    ? result[imageStoreKey]
    : {};
  const { messages: compactMessages, imageStore } = compactSessionMessages(messages, {
    existingImageStore,
    additionalReferencedMessages: normalizeQueuedMessages(result[key]?.queuedMessages)
  });
  const nextImageRefIndex = deriveNextImageRefIndex({
    messages: compactMessages,
    imageStore,
    fallback: options.nextImageRefIndex ?? result[key]?.nextImageRefIndex
  });
  await chrome.storage.local.set({
    [key]: {
      ...result[key],
      messages: compactMessages,
      nextImageRefIndex
    },
    [imageStoreKey]: imageStore || existingImageStore || {}
  });

  if (title && !entry.manualTitle) entry.title = title;
  if (!entry.startedAt && messages && messages.length > 0) entry.startedAt = Date.now();
  if (Object.prototype.hasOwnProperty.call(options, "contextUsage")) {
    const nextContextUsage = normalizeSessionIndexContextUsage(options.contextUsage);
    if (nextContextUsage) {
      entry.contextUsage = nextContextUsage;
    } else {
      delete entry.contextUsage;
    }
  }
  entry.updatedAt = Date.now();
  await chrome.storage.local.set({ sessions_index });
  return true;
}

function normalizeSessionIndexContextUsage(contextUsage) {
  const tokens = Number(contextUsage?.tokens);
  if (!Number.isFinite(tokens)) return null;
  return {
    tokens,
    usageStatus: contextUsage?.usageStatus || "ok",
    apiType: contextUsage?.apiType || "",
    model: contextUsage?.model || ""
  };
}

const SESSION_IMAGE_STORE_REF_PREFIX = "session-image:";

function getSessionImageStoreKey(id) {
  return `session_${id}_images`;
}

async function loadSessionLocks() {
  const result = await chrome.storage.local.get({ [SESSION_LOCKS_KEY]: {} });
  const locks = result[SESSION_LOCKS_KEY];
  return locks && typeof locks === "object" ? { ...locks } : {};
}

function normalizeWindowId(value) {
  const raw = String(value ?? "").trim();
  return raw && raw !== "-1" ? raw : "";
}

function isSessionLockExpired(lock, now = Date.now()) {
  const updatedAt = Number(lock?.updatedAt || 0);
  return !updatedAt || now - updatedAt > SESSION_LOCK_TTL_MS;
}

async function sessionLockWindowExists(windowId) {
  const normalizedWindowId = normalizeWindowId(windowId);
  if (!normalizedWindowId || !chrome?.windows?.get) return true;
  try {
    await chrome.windows.get(Number(normalizedWindowId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk an arbitrary message tree and collect every imageStore key it still
 * points at. Recognized reference shapes:
 *   - `block.source.ref` when `block.source.type === "session_image"`
 *   - hydrated image refs such as `imageRefs[].ref`, `block.ref`, or
 *     `block.source.ref` when paired with base64 payloads
 *   - any string of the form `session-image:img_X` in any object field
 * Used by the pre-sweep in compactSessionMessages to drop orphan entries
 * without touching anything that is legitimately reachable (including
 * un-hydrated messages produced during the openSession hydrate window and
 * hydrated messages already carrying inline base64 data).
 */
function collectReferencedImageStoreKeys(messages) {
  const keys = new Set();
  function addKey(value) {
    const normalized = normalizeImageStoreKey(value);
    if (normalized) keys.add(normalized);
  }
  function visit(value, depth = 0) {
    if (depth > 12 || value == null) return;
    if (typeof value === "string") {
      if (value.startsWith(SESSION_IMAGE_STORE_REF_PREFIX)) {
        addKey(value.slice(SESSION_IMAGE_STORE_REF_PREFIX.length));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (value.type === "image" && value.source?.type === "session_image") {
      addKey(value.source.ref);
    }
    if (value.type === "image" && value.source?.type === "base64") {
      addKey(value.ref || value.source.ref);
    }
    if (Array.isArray(value.imageRefs)) {
      for (const item of value.imageRefs) {
        addKey(item?.ref);
      }
    }
    for (const child of Object.values(value)) {
      visit(child, depth + 1);
    }
  }
  visit(messages);
  return keys;
}

export function compactSessionMessages(messages, options = {}) {
  if (!Array.isArray(messages)) {
    return {
      messages,
      imageStore: cloneImageStore(options.existingImageStore)
    };
  }

  const imageStore = cloneImageStore(options.existingImageStore);

  if (options.pruneUnreferencedImageStore !== false) {
    // Pre-sweep: drop any imageStore entry that no input message references.
    // This must happen before computing nextIndex / byValue so that allocations
    // can re-use freed slots and the resulting index stays tight. It also fully
    // recovers from latent bugs that leave orphan entries behind.
    const referencedKeys = collectReferencedImageStoreKeys([
      ...messages,
      ...(Array.isArray(options.additionalReferencedMessages) ? options.additionalReferencedMessages : [])
    ]);
    for (const key of Object.keys(imageStore)) {
      if (!referencedKeys.has(key)) {
        console.warn(`[sessions] compactSessionMessages dropping orphan image ref ${key}`);
        delete imageStore[key];
      }
    }
  }

  const byValue = new Map(
    Object.entries(imageStore)
      .filter(([, value]) => isBase64DataUrl(value))
      .map(([key, value]) => [value, key])
  );
  let nextIndex = deriveNextImageRefIndex({
    imageStore,
    fallback: 1
  });

  function storeDataUrl(dataUrl, preferredKey = "") {
    const raw = String(dataUrl || "");
    if (!isBase64DataUrl(raw)) return raw;

    const normalizedPreferredKey = normalizeImageStoreKey(preferredKey);
    if (normalizedPreferredKey) {
      const existingValue = imageStore[normalizedPreferredKey];
      if (!existingValue || existingValue === raw) {
        imageStore[normalizedPreferredKey] = raw;
        byValue.set(raw, normalizedPreferredKey);
        nextIndex = Math.max(nextIndex, normalizeNextImageRefIndex(numericImageRefSuffix(normalizedPreferredKey) + 1));
        return `${SESSION_IMAGE_STORE_REF_PREFIX}${normalizedPreferredKey}`;
      }
    }

    const existing = byValue.get(raw);
    if (existing) return `${SESSION_IMAGE_STORE_REF_PREFIX}${existing}`;

    let key = normalizedPreferredKey;
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
    if (source.type === "session_image" && normalizeImageStoreKey(source.ref)) {
      return {
        ...source,
        ref: normalizeImageStoreKey(source.ref)
      };
    }
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
      const imageRef = normalizeImageStoreKey(value.ref || value.source?.ref || preferredKey);
      return {
        ...value,
        ...(imageRef ? { ref: imageRef } : {}),
        source: storeImageBlockSource(value.source, imageRef)
      };
    }
    const preferredRefsByValue = buildPreferredImageStoreRefsByValue(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        compactValue(child, getImageStorePreferredKeyForChild(key, child, value, preferredRefsByValue))
      ])
    );
  }

  const compactMessages = messages.map(message => compactValue(message));

  const hasImageStoreEntries = Object.keys(imageStore).length > 0;
  const hasExistingImageStoreEntries = Object.keys(options.existingImageStore || {}).length > 0;
  return {
    messages: compactMessages,
    imageStore: hasImageStoreEntries || hasExistingImageStoreEntries ? imageStore : undefined
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
        const sourceRef = normalizeImageStoreKey(value.source.ref);
        return {
          ...value,
          ...(normalizeImageStoreKey(value.ref || value.source.ref) ? { ref: normalizeImageStoreKey(value.ref || value.source.ref) } : {}),
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
            ...(sourceRef ? { ref: sourceRef } : {})
          }
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

function getImageStorePreferredKeyForChild(key, child, parent, preferredRefsByValue = new Map()) {
  if (!isImageDataFieldName(key) || typeof child !== "string") return "";
  return normalizeImageStoreKey(
    preferredRefsByValue.get(child) ||
    parent?.ref ||
    parent?.source?.ref
  );
}

function isImageDataFieldName(key) {
  return /^(dataUrl|displayImageUrl|url|source)$/i.test(String(key || ""));
}

function isBase64DataUrl(value) {
  return typeof value === "string" && /^data:[^;]+;base64,/.test(value);
}

function parseImageDataUrl(dataUrl) {
  const raw = typeof dataUrl === "string" ? dataUrl : "";
  if (!raw.startsWith("data:")) return null;
  const marker = ";base64,";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex <= "data:".length) return null;
  const mediaType = raw.slice("data:".length, markerIndex);
  const data = raw.slice(markerIndex + marker.length);
  if (!mediaType || !data) return null;
  return { mediaType, data };
}

function buildPreferredImageStoreRefsByValue(value) {
  const refsByValue = new Map();
  if (!value || typeof value !== "object") return refsByValue;

  for (const item of Array.isArray(value.imageRefs) ? value.imageRefs : []) {
    const ref = normalizeImageStoreKey(item?.ref);
    const source = normalizeStoredImageSource(item?.dataUrl || item?.source || item?.url);
    if (ref && source) refsByValue.set(source, ref);
  }

  for (const image of Array.isArray(value.displayImages) ? value.displayImages : []) {
    const ref = normalizeImageStoreKey(image?.ref);
    const source = normalizeStoredImageSource(image?.url);
    if (ref && source) refsByValue.set(source, ref);
  }

  const blockImageSource = normalizeBlockImageSource(value);
  const blockImageRef = normalizeImageStoreKey(value.ref || value?.source?.ref);
  if (blockImageRef && blockImageSource) {
    refsByValue.set(blockImageSource, blockImageRef);
  }

  return refsByValue;
}

function normalizeStoredImageSource(source) {
  const raw = String(source || "");
  if (!raw) return "";
  if (isBase64DataUrl(raw)) return raw;
  return raw.startsWith(SESSION_IMAGE_STORE_REF_PREFIX) ? raw : "";
}

function normalizeBlockImageSource(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type !== "image") return "";
  if (block.source?.type === "base64" && block.source.media_type && block.source.data) {
    return `data:${block.source.media_type};base64,${block.source.data}`;
  }
  if (block.source?.type === "session_image" && normalizeImageStoreKey(block.source.ref)) {
    return `${SESSION_IMAGE_STORE_REF_PREFIX}${normalizeImageStoreKey(block.source.ref)}`;
  }
  return "";
}

function deriveNextImageRefIndex({ messages = [], imageStore = {}, fallback = 1 } = {}) {
  let maxIndex = Number.isFinite(Number(fallback)) ? Number(fallback) - 1 : 0;

  const trackRef = (value) => {
    const normalized = normalizeImageStoreKey(value);
    if (!normalized) return;
    maxIndex = Math.max(maxIndex, numericImageRefSuffix(normalized));
  };

  const visit = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      const storedRef = value.startsWith(SESSION_IMAGE_STORE_REF_PREFIX)
        ? value.slice(SESSION_IMAGE_STORE_REF_PREFIX.length)
        : "";
      trackRef(storedRef);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    trackRef(value.ref);
    trackRef(value?.source?.ref);
    for (const child of Object.values(value)) {
      visit(child, depth + 1);
    }
  };

  for (const key of Object.keys(imageStore || {})) {
    trackRef(key);
  }
  visit(messages);

  return normalizeNextImageRefIndex(maxIndex + 1);
}

function numericImageRefSuffix(value) {
  return Number(String(value || "").match(/^img_(\d+)$/)?.[1] || 0);
}

function normalizeNextImageRefIndex(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : 1;
}

function cloneImageStore(imageStore) {
  return imageStore && typeof imageStore === "object"
    ? Object.fromEntries(Object.entries(imageStore))
    : {};
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
 * @param {{systemPrompt?: string, plans?: Array, contextSummary?: object | null, queuedMessages?: Array}} meta - partial session metadata
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
  const lastActiveByWindowResult = await chrome.storage.local.get({ [LAST_ACTIVE_SESSION_BY_WINDOW_KEY]: {} });
  const lastActiveByWindow = lastActiveByWindowResult[LAST_ACTIVE_SESSION_BY_WINDOW_KEY];
  const nextLastActiveByWindow = lastActiveByWindow && typeof lastActiveByWindow === "object"
    ? { ...lastActiveByWindow }
    : {};
  for (const [windowId, sessionId] of Object.entries(nextLastActiveByWindow)) {
    if (sessionId === id) delete nextLastActiveByWindow[windowId];
  }
  const locks = await loadSessionLocks();
  if (locks[id]) delete locks[id];
  const keysToRemove = [
    key,
    getSessionImageStoreKey(id),
    ...(lastActiveSessionId === id ? [LAST_ACTIVE_SESSION_ID_KEY] : [])
  ];
  await chrome.storage.local.remove(keysToRemove);

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] });
  const updated = sessions_index.filter(s => s.id !== id);
  await chrome.storage.local.set({
    sessions_index: updated,
    [LAST_ACTIVE_SESSION_BY_WINDOW_KEY]: nextLastActiveByWindow,
    [SESSION_LOCKS_KEY]: locks
  });
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
