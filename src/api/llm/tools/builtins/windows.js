/* global chrome */
import { _buildCapturedAt, _serializeWindowMetadata, _serializeTabMetadata } from "./_shared";

export async function _execWindowList() {
  const capturedAt = _buildCapturedAt();
  const [windows, currentWindow] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.windows.getCurrent({})
  ]);
  return {
    capturedAt,
    count: windows.length,
    currentWindowId: currentWindow?.id ?? null,
    windows: windows.map(win => _serializeWindowMetadata(win, currentWindow?.id ?? null))
  };
}

/**
 * Get info about the current browser window.
 */
export async function _execWindowGetCurrent() {
  const capturedAt = _buildCapturedAt();
  const win = await chrome.windows.getCurrent({ populate: true });
  return {
    capturedAt,
    window: _serializeWindowMetadata(win, win.id)
  };
}

/**
 * Focus a browser window by ID.
 */
export async function _execWindowFocus({ windowId }) {
  const previousWindow = await chrome.windows.getCurrent({});
  await chrome.windows.update(windowId, { focused: true });
  const focusedWindow = await chrome.windows.get(windowId, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    previousWindowId: previousWindow?.id ?? null,
    window: _serializeWindowMetadata(focusedWindow, windowId)
  };
}

/**
 * Move one or more tabs into a target window.
 */
export async function _execWindowMoveTab({ tabIds, windowId }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const moved = await chrome.tabs.move(ids, { windowId, index: -1 });
  const movedTabs = Array.isArray(moved) ? moved : [moved];
  const currentWindow = await chrome.windows.getCurrent({});
  const targetWindow = await chrome.windows.get(windowId, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    windowId,
    movedCount: movedTabs.length,
    movedTabs: movedTabs.map(tab => _serializeTabMetadata(tab)),
    window: _serializeWindowMetadata(targetWindow, currentWindow?.id ?? null)
  };
}

/**
 * Create a new browser window.
 */
export async function _execWindowCreate({ url, focused }) {
  const createData = {};
  if (url) createData.url = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  if (focused != null) createData.focused = focused;

  const createdWindow = await chrome.windows.create(createData);
  const win = await chrome.windows.get(createdWindow.id, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    window: _serializeWindowMetadata(win, win.id)
  };
}

/**
 * Close a browser window by ID.
 */
export async function _execWindowClose({ windowId }) {
  const currentWindow = await chrome.windows.getCurrent({});
  const win = await chrome.windows.get(windowId, { populate: true });
  const snapshot = _serializeWindowMetadata(win, currentWindow?.id ?? null);
  await chrome.windows.remove(windowId);
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    closedWindowId: windowId,
    window: snapshot
  };
}
