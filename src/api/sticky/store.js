/* global chrome */
/**
 * Sticky board storage: pages "stuck" to the tab manager like sticky notes.
 *
 * - The board (lanes + notes) lives under one chrome.storage.local key.
 * - Thumbnails live under one key per note so board updates stay small.
 * - A note is "live" while `tabId` is set. `reconcileBoard` keeps that binding
 *   honest: it follows same-origin navigation, detaches when the tab closes or
 *   leaves the origin, and re-binds detached notes to an open tab by URL.
 *
 * Used from both the side panel and the service worker, so it must not touch
 * the DOM.
 */

export const BOARD_KEY = "stickyBoard";
export const PREFS_KEY = "stickyBoardPrefs";
export const THUMB_PREFIX = "stickyThumb:";
const SESSION_KEY = "stickySessionReady";
/** Must match the command name in manifest.json. */
export const PIN_COMMAND = "pin-current-tab";

/** Colours handed out to lanes. Notes without a lane use DEFAULT_COLOR, which is never a lane colour. */
export const LANE_COLORS = ["yellow", "pink", "green", "purple", "orange", "blue"];
export const DEFAULT_COLOR = "sky";
export const DEFAULT_PREFS = { size: "m", activeLane: "all" };
/** Finished notes are deleted automatically this long after they were marked done. */
export const DONE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

// Wide enough to stay sharp when a card fills the side panel on a HiDPI screen.
const THUMB_WIDTH = 1280;
const THUMB_ASPECT = 10 / 16;

function emptyBoard() {
  return { version: 1, lanes: [], notes: [] };
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function thumbKey(noteId) {
  return THUMB_PREFIX + noteId;
}

export function stripHash(url) {
  return String(url || "").split("#")[0];
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(":", "");
  } catch {
    return "";
  }
}

/** Blank/new-tab URLs say nothing about where a tab is going, so they never detach a note. */
function isMeaningfulUrl(url) {
  return !!url && url !== "about:blank" && !/^(chrome|edge):\/\/newtab\/?$/.test(url);
}

function tabUrlOf(tab) {
  return tab?.url || tab?.pendingUrl || "";
}

/**
 * Pure reconciliation of notes against the currently open tabs.
 * Returns a new board plus whether anything changed.
 */
export function reconcileBoard(board, tabs, { freshSession = false } = {}) {
  let changed = false;
  const openTabs = Array.isArray(tabs) ? tabs : [];
  const tabsById = new Map(openTabs.map(tab => [tab.id, tab]));
  const boundTabIds = new Set();
  const notes = (board?.notes || []).map(note => ({ ...note }));

  for (const note of notes) {
    if (note.tabId == null) continue;
    // Tab ids restart after a browser restart, so stale ids could point at an
    // unrelated tab. Drop them and let the URL pass below re-bind.
    if (freshSession || note.done) {
      note.tabId = null;
      changed = true;
      continue;
    }
    const tab = tabsById.get(note.tabId);
    if (!tab) {
      note.tabId = null;
      changed = true;
      continue;
    }
    const url = tabUrlOf(tab);
    if (!isMeaningfulUrl(url)) {
      boundTabIds.add(tab.id);
      continue;
    }
    if (originOf(url) !== originOf(note.url)) {
      note.tabId = null;
      changed = true;
      continue;
    }
    boundTabIds.add(tab.id);
    changed = adoptTabState(note, tab, url) || changed;
  }

  for (const note of notes) {
    if (note.tabId != null || note.done) continue;
    const target = stripHash(note.url);
    const tab = openTabs.find(candidate => !boundTabIds.has(candidate.id) && stripHash(tabUrlOf(candidate)) === target);
    if (!tab) continue;
    note.tabId = tab.id;
    boundTabIds.add(tab.id);
    adoptTabState(note, tab, tabUrlOf(tab));
    changed = true;
  }

  return { board: { ...emptyBoard(), ...board, notes }, changed };
}

function adoptTabState(note, tab, url) {
  let changed = false;
  if (note.url !== url) {
    note.url = url;
    changed = true;
  }
  if (tab.windowId != null && note.windowId !== tab.windowId) {
    note.windowId = tab.windowId;
    changed = true;
  }
  // While loading, Chrome reports the URL as the title; wait for the real one.
  if (tab.status !== "loading" && tab.title && tab.title !== note.title) {
    note.title = tab.title;
    changed = true;
  }
  if (tab.favIconUrl && tab.favIconUrl !== note.favIconUrl) {
    note.favIconUrl = tab.favIconUrl;
    changed = true;
  }
  return changed;
}

export function laneColor(board, laneId) {
  return board?.lanes?.find(lane => lane.id === laneId)?.color || DEFAULT_COLOR;
}

export function displayTitle(note) {
  return note?.customTitle || note?.title || note?.url || "";
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function loadBoard() {
  const { [BOARD_KEY]: stored } = await chrome.storage.local.get({ [BOARD_KEY]: null });
  const board = { ...emptyBoard(), ...(stored || {}) };
  board.lanes = Array.isArray(board.lanes) ? board.lanes : [];
  board.notes = Array.isArray(board.notes) ? board.notes : [];
  return board;
}

let writeChain = Promise.resolve();

/**
 * Serialized read-modify-write. `mutator` edits the draft in place and its
 * return value is passed through. Nothing is written if the draft is unchanged.
 */
function mutateBoard(mutator) {
  const run = writeChain.then(async () => {
    const board = await loadBoard();
    const before = JSON.stringify(board);
    const result = await mutator(board);
    if (JSON.stringify(board) !== before) {
      await chrome.storage.local.set({ [BOARD_KEY]: board });
    }
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
}

export async function loadPrefs() {
  const { [PREFS_KEY]: stored } = await chrome.storage.local.get({ [PREFS_KEY]: null });
  return { ...DEFAULT_PREFS, ...(stored || {}) };
}

export async function savePrefs(patch) {
  const next = { ...(await loadPrefs()), ...patch };
  await chrome.storage.local.set({ [PREFS_KEY]: next });
  return next;
}

export async function loadThumbs(noteIds) {
  const keys = noteIds.map(thumbKey);
  if (!keys.length) return {};
  const stored = await chrome.storage.local.get(keys);
  const thumbs = {};
  for (const id of noteIds) {
    if (stored[thumbKey(id)]) thumbs[id] = stored[thumbKey(id)];
  }
  return thumbs;
}

// ---------------------------------------------------------------------------
// Tab tracking
// ---------------------------------------------------------------------------

async function consumeFreshSession() {
  const session = chrome.storage?.session;
  if (!session) return false;
  try {
    const stored = await session.get(SESSION_KEY);
    if (stored?.[SESSION_KEY]) return false;
    await session.set({ [SESSION_KEY]: true });
    return true;
  } catch {
    return false;
  }
}

/** When a note was finished. Notes finished before `doneAt` existed fall back to their last update. */
export function doneTime(note) {
  return note?.doneAt ?? note?.updatedAt ?? note?.createdAt ?? 0;
}

/** Pure: split notes into those to keep and the finished ones past the retention window. */
export function splitExpiredDone(notes, now = Date.now()) {
  const kept = [];
  const expired = [];
  for (const note of notes) {
    if (note.done && now - doneTime(note) >= DONE_RETENTION_MS) expired.push(note);
    else kept.push(note);
  }
  return { kept, expired };
}

/**
 * Sync notes with the open tabs, and drop finished notes older than the
 * retention window (with their thumbnails). Runs on tab events, on browser
 * start and whenever the side panel opens.
 */
export async function reconcileStickies() {
  const freshSession = await consumeFreshSession();
  const tabs = await chrome.tabs.query({});
  let expiredIds = [];
  const changed = await mutateBoard(board => {
    const { kept, expired } = splitExpiredDone(board.notes);
    expiredIds = expired.map(note => note.id);
    if (expired.length) board.notes = kept;
    const result = reconcileBoard(board, tabs, { freshSession });
    if (result.changed) board.notes = result.board.notes;
    return result.changed || expired.length > 0;
  });
  if (expiredIds.length) await chrome.storage.local.remove(expiredIds.map(thumbKey));
  return changed;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Capture the visible tab of a window and shrink it to a small JPEG data URL. Returns null on failure. */
export async function captureThumbnail(windowId) {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 92 });
    if (!raw) return null;
    const bitmap = await createImageBitmap(await (await fetch(raw)).blob());
    const sourceHeight = Math.min(bitmap.height, Math.round(bitmap.width * THUMB_ASPECT));
    const width = Math.min(THUMB_WIDTH, bitmap.width);
    const height = Math.round(width * (sourceHeight / bitmap.width));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, bitmap.width, sourceHeight, 0, 0, width, height);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    return `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } catch {
    return null;
  }
}

async function storeThumb(noteId, dataUrl) {
  if (!dataUrl) return false;
  await chrome.storage.local.set({ [thumbKey(noteId)]: dataUrl });
  return true;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Stick a tab to the board. If the tab already has a note, returns it with
 * `duplicate: true` instead of creating another.
 */
export async function pinTab(tab, { laneId = null } = {}) {
  const url = tabUrlOf(tab);
  if (!tab || !url) throw new Error("NO_TAB");

  const existing = (await loadBoard()).notes.find(note => !note.done && note.tabId === tab.id);
  if (existing) return { note: existing, duplicate: true };

  const id = newId("st");
  // captureVisibleTab can only see the active tab of a window.
  const hasThumb = tab.active ? await storeThumb(id, await captureThumbnail(tab.windowId)) : false;

  const note = await mutateBoard(board => {
    const now = Date.now();
    const created = {
      id,
      url,
      pinnedUrl: url,
      title: tab.title || url,
      customTitle: "",
      note: "",
      favIconUrl: tab.favIconUrl || "",
      laneId: board.lanes.some(lane => lane.id === laneId) ? laneId : null,
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      hasThumb,
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    board.notes.unshift(created);
    return created;
  });
  return { note, duplicate: false };
}

export async function pinActiveTab(options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return pinTab(tab, options);
}

export function updateNote(noteId, patch) {
  return mutateBoard(board => {
    const note = board.notes.find(item => item.id === noteId);
    if (!note) return null;
    Object.assign(note, patch, { updatedAt: Date.now() });
    return note;
  });
}

/**
 * Pure: put the notes named in `orderedIds` into that order, using only the
 * slots those notes already occupy, so notes outside the list do not move.
 */
export function applyOrder(notes, orderedIds) {
  const byId = new Map(notes.map(note => [note.id, note]));
  const ids = orderedIds.filter(id => byId.has(id));
  const moving = new Set(ids);
  let next = 0;
  return notes.map(note => (moving.has(note.id) ? byId.get(ids[next++]) : note));
}

export function reorderNotes(orderedIds) {
  return mutateBoard(board => {
    board.notes = applyOrder(board.notes, orderedIds);
  });
}

export function setNoteDone(noteId, done) {
  return updateNote(noteId, done ? { done: true, tabId: null, doneAt: Date.now() } : { done: false, doneAt: null });
}

export async function removeNote(noteId) {
  await mutateBoard(board => {
    board.notes = board.notes.filter(note => note.id !== noteId);
  });
  await chrome.storage.local.remove(thumbKey(noteId));
}

/** Focus the note's tab, or reopen its URL in a new tab if the tab is gone. */
export async function openNote(noteId) {
  const note = (await loadBoard()).notes.find(item => item.id === noteId);
  if (!note) return { revived: false, missing: true };

  if (note.tabId != null) {
    try {
      const tab = await chrome.tabs.get(note.tabId);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        return { revived: false };
      }
    } catch { /* tab is gone; fall through and revive */ }
  }

  const tab = await chrome.tabs.create({ url: note.url, active: true });
  await updateNote(noteId, { tabId: tab.id, windowId: tab.windowId ?? null, done: false });
  return { revived: true };
}

/** Re-capture the screenshot of a live note, switching to its tab first if needed. */
export async function refreshThumbnail(noteId) {
  const note = (await loadBoard()).notes.find(item => item.id === noteId);
  if (!note || note.tabId == null) return false;
  let tab;
  try {
    tab = await chrome.tabs.get(note.tabId);
  } catch {
    return false;
  }
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await delay(450);
  }
  const stored = await storeThumb(noteId, await captureThumbnail(tab.windowId));
  if (stored && !note.hasThumb) await updateNote(noteId, { hasThumb: true });
  return stored;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export function addLane(name) {
  return mutateBoard(board => {
    const used = new Set(board.lanes.map(lane => lane.color));
    const color = LANE_COLORS.find(candidate => !used.has(candidate))
      || LANE_COLORS[board.lanes.length % LANE_COLORS.length];
    const lane = { id: newId("ln"), name: String(name || "").trim(), color };
    board.lanes.push(lane);
    return lane;
  });
}

export function renameLane(laneId, name) {
  return mutateBoard(board => {
    const lane = board.lanes.find(item => item.id === laneId);
    if (lane) lane.name = String(name || "").trim() || lane.name;
    return lane || null;
  });
}

/** Removes the lane; its notes stay on the board without a lane. */
export function removeLane(laneId) {
  return mutateBoard(board => {
    board.lanes = board.lanes.filter(lane => lane.id !== laneId);
    for (const note of board.notes) {
      if (note.laneId === laneId) note.laneId = null;
    }
  });
}
