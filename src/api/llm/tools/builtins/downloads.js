/* global chrome */
import { triggerBrowserDownload, hasDownloadsPermission, downloadsPermissionRequiredError } from "./downloadHelper";

export async function _execDownload({ fileName, url, content, mimeType } = {}) {
  return await triggerBrowserDownload({ fileName, url, content, mimeType });
}
function _serializeDownloadItem(item) {
  return {
    id: item.id,
    url: item.url || "",
    finalUrl: item.finalUrl || "",
    filename: item.filename || "",
    state: item.state || "",
    mime: item.mime || "",
    totalBytes: typeof item.totalBytes === "number" ? item.totalBytes : null,
    bytesReceived: typeof item.bytesReceived === "number" ? item.bytesReceived : null,
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    paused: !!item.paused,
    exists: item.exists !== false,
    error: item.error || null,
    danger: item.danger || null
  };
}

/**
 * List the most recent downloads.
 */
export async function _execDownloadList({ limit } = {}) {
  if (!chrome?.downloads?.search) {
    return { error: "chrome.downloads API is unavailable in this context" };
  }
  if (!(await hasDownloadsPermission())) {
    return downloadsPermissionRequiredError();
  }
  const max = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
  try {
    const items = await chrome.downloads.search({ limit: max, orderBy: ["-startTime"] });
    return {
      count: items.length,
      downloads: items.map(_serializeDownloadItem)
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/**
 * Search downloads with optional filters.
 */
export async function _execDownloadSearch({ query, filenameRegex, urlRegex, state, startedAfter, startedBefore, limit } = {}) {
  if (!chrome?.downloads?.search) {
    return { error: "chrome.downloads API is unavailable in this context" };
  }
  if (!(await hasDownloadsPermission())) {
    return downloadsPermissionRequiredError();
  }

  const q = { orderBy: ["-startTime"] };

  if (typeof query === "string" && query.trim()) {
    // chrome.downloads.search expects an array of terms; all must match.
    q.query = query.trim().split(/\s+/);
  }
  if (typeof filenameRegex === "string" && filenameRegex.length > 0) {
    q.filenameRegex = filenameRegex;
  }
  if (typeof urlRegex === "string" && urlRegex.length > 0) {
    q.urlRegex = urlRegex;
  }
  if (state && ["in_progress", "interrupted", "complete"].includes(state)) {
    q.state = state;
  }
  if (Number.isFinite(startedAfter)) {
    q.startedAfter = new Date(startedAfter).toISOString();
  }
  if (Number.isFinite(startedBefore)) {
    q.startedBefore = new Date(startedBefore).toISOString();
  }
  q.limit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));

  try {
    const items = await chrome.downloads.search(q);
    return {
      count: items.length,
      query: q,
      downloads: items.map(_serializeDownloadItem)
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}
