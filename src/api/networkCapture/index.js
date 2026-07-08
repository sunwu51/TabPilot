/* global chrome */

const ACTIVE_CAPTURE_KEY = "networkCaptureActive";
const CAPTURE_INDEX_PREFIX = "networkCaptureIndex_";
const CAPTURE_DETAILS_PREFIX = "networkCaptureDetails_";
const MAX_CAPTURE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_CAPTURE_DURATION_MS = MAX_CAPTURE_DURATION_MS;
const MAX_CAPTURE_EVENTS = 500;
const MAX_DETAIL_QUERY = 100;
const CLEANUP_ALARM_PREFIX = "network_capture_cleanup_";
const CAPTURE_SCOPES = new Set(["active_tab", "all"]);

let activeCapture = null;
let registered = false;

function makeId(prefix = "cap") {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

function indexKey(captureId) {
  return `${CAPTURE_INDEX_PREFIX}${captureId}`;
}

function detailsKey(captureId) {
  return `${CAPTURE_DETAILS_PREFIX}${captureId}`;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean);
}

function normalizeRegexArray(value, fieldName) {
  const patterns = normalizeStringArray(value);
  const regexes = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern, "i"));
    } catch {
      return { error: `${fieldName} contains an invalid regular expression: ${pattern}` };
    }
  }
  return { patterns, regexes };
}

function normalizeFilters(filters = {}) {
  const pathIncludes = normalizeStringArray(filters.pathIncludes);
  const hostIncludes = normalizeStringArray(filters.hostIncludes).map(item => item.toLowerCase());
  const methods = normalizeStringArray(filters.methods).map(item => item.toUpperCase());
  const resourceTypes = normalizeStringArray(filters.resourceTypes);
  const contentTypes = normalizeStringArray(filters.contentTypes).map(item => item.toLowerCase());
  const urlRegex = normalizeRegexArray(filters.urlRegex, "urlRegex");
  if (urlRegex.error) return urlRegex;
  const pathRegex = normalizeRegexArray(filters.pathRegex, "pathRegex");
  if (pathRegex.error) return pathRegex;

  return {
    pathIncludes,
    hostIncludes,
    methods,
    resourceTypes,
    contentTypes,
    urlRegex: urlRegex.patterns,
    pathRegex: pathRegex.patterns,
    _urlRegex: urlRegex.regexes,
    _pathRegex: pathRegex.regexes
  };
}

function getHeader(headers = [], name) {
  const lower = String(name || "").toLowerCase();
  const found = (headers || []).find(header => String(header?.name || "").toLowerCase() === lower);
  return found?.value || "";
}

function serializeHeaders(headers = []) {
  return (headers || [])
    .filter(header => header?.name)
    .map(header => ({ name: String(header.name), value: String(header.value ?? "") }));
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizeScope(scope) {
  const value = String(scope || "active_tab").trim();
  return CAPTURE_SCOPES.has(value) ? value : "active_tab";
}

async function resolveActiveHttpTab() {
  let tab = null;
  try {
    const currentWindow = await chrome.windows.getCurrent({});
    if (currentWindow?.id != null) {
      const [activeInCurrentWindow] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
      if (activeInCurrentWindow?.id != null) tab = activeInCurrentWindow;
    }
  } catch (_e) {
    // Fall back to the last focused browser window below.
  }

  if (!tab) {
    try {
      const [activeInLastFocusedWindow] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeInLastFocusedWindow?.id != null) tab = activeInLastFocusedWindow;
    } catch (_e) {
      return null;
    }
  }

  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return null;
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || "",
    title: tab.title || ""
  };
}

function requestMatchesFilters(details, capture) {
  if (!capture || !details?.url || !/^https?:\/\//i.test(details.url)) return false;
  if (capture.scope === "active_tab" && details.tabId !== capture.targetTab?.tabId) return false;
  const filters = capture.filters || {};
  const parsed = parseUrl(details.url);
  if (!parsed) return false;

  const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
  const host = parsed.hostname.toLowerCase();
  const method = String(details.method || "").toUpperCase();
  const type = String(details.type || "");

  if (filters.methods?.length && !filters.methods.includes(method)) return false;
  if (filters.resourceTypes?.length && !filters.resourceTypes.includes(type)) return false;
  if (filters.hostIncludes?.length && !filters.hostIncludes.some(item => host.includes(item))) return false;
  if (filters.pathIncludes?.length && !filters.pathIncludes.some(item => path.includes(item))) return false;
  if (filters._urlRegex?.length && !filters._urlRegex.some(regex => regex.test(details.url))) return false;
  if (filters._pathRegex?.length && !filters._pathRegex.some(regex => regex.test(path))) return false;
  return true;
}

function responseMatchesFilters(entry, capture) {
  const contentTypes = capture?.filters?.contentTypes || [];
  if (!contentTypes.length) return true;
  const contentType = String(entry.response?.contentType || "").toLowerCase();
  return contentTypes.some(item => contentType.includes(item));
}

function sanitizeFiltersForStorage(filters) {
  const copy = { ...filters };
  delete copy._urlRegex;
  delete copy._pathRegex;
  return copy;
}

function hydrateFiltersFromStorage(filters = {}) {
  const hydrated = normalizeFilters(filters);
  if (hydrated.error) return { ...filters, _urlRegex: [], _pathRegex: [] };
  return hydrated;
}

async function persistActiveCapture() {
  if (!activeCapture) {
    await chrome.storage.local.remove(ACTIVE_CAPTURE_KEY);
    return;
  }
  await chrome.storage.local.set({
    [ACTIVE_CAPTURE_KEY]: {
      ...activeCapture,
      filters: sanitizeFiltersForStorage(activeCapture.filters)
    }
  });
}

async function readCaptureIndex(captureId) {
  const key = indexKey(captureId);
  const result = await chrome.storage.local.get({ [key]: { captureId, requests: [] } });
  return result[key] || { captureId, requests: [] };
}

async function writeCaptureIndex(captureId, index) {
  await chrome.storage.local.set({ [indexKey(captureId)]: index });
}

async function readCaptureDetails(captureId) {
  const key = detailsKey(captureId);
  const result = await chrome.storage.local.get({ [key]: {} });
  return result[key] || {};
}

async function writeCaptureDetails(captureId, details) {
  await chrome.storage.local.set({ [detailsKey(captureId)]: details });
}

function scheduleCleanup(captureId, cleanupAt) {
  chrome.alarms.create(`${CLEANUP_ALARM_PREFIX}${captureId}`, { when: Math.max(Date.now() + 1000, cleanupAt) });
}

function isExpired(capture) {
  return !capture || Date.now() >= Number(capture.expiresAt || 0);
}

async function ensureStoppedIfExpired() {
  if (activeCapture && isExpired(activeCapture)) {
    await stopNetworkCapture({ reason: "expired" });
  }
}

function addListeners() {
  if (registered || !chrome.webRequest) return;
  chrome.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ["http://*/*", "https://*/*"] },
    ["requestBody"]
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    handleBeforeSendHeaders,
    { urls: ["http://*/*", "https://*/*"] },
    ["requestHeaders"]
  );
  chrome.webRequest.onHeadersReceived.addListener(
    handleHeadersReceived,
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders"]
  );
  chrome.webRequest.onCompleted.addListener(
    handleCompleted,
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders"]
  );
  chrome.webRequest.onErrorOccurred.addListener(
    handleErrorOccurred,
    { urls: ["http://*/*", "https://*/*"] }
  );
  registered = true;
}

async function upsertEntry(webRequestId, patch) {
  if (!activeCapture) return;
  const captureId = activeCapture.captureId;
  const details = await readCaptureDetails(captureId);
  const existing = details[webRequestId] || {};
  details[webRequestId] = { ...existing, ...patch, updatedAt: Date.now() };
  await writeCaptureDetails(captureId, details);
}

async function patchExistingEntry(webRequestId, patch) {
  if (!activeCapture) return;
  const captureId = activeCapture.captureId;
  const details = await readCaptureDetails(captureId);
  if (!details[webRequestId]) return;
  details[webRequestId] = { ...details[webRequestId], ...patch, updatedAt: Date.now() };
  await writeCaptureDetails(captureId, details);
}

async function removeEntry(webRequestId) {
  if (!activeCapture) return;
  const captureId = activeCapture.captureId;
  const details = await readCaptureDetails(captureId);
  if (!details[webRequestId]) return;
  delete details[webRequestId];
  await writeCaptureDetails(captureId, details);
}

async function handleBeforeRequest(details) {
  await ensureStoppedIfExpired();
  if (!activeCapture || !requestMatchesFilters(details, activeCapture)) return;

  const captureId = activeCapture.captureId;
  const detailId = makeId("net");
  const parsed = parseUrl(details.url);
  const entry = {
    uuid: detailId,
    captureId,
    webRequestId: details.requestId,
    tabId: details.tabId,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    type: details.type,
    initiator: details.initiator || "",
    request: {
      method: details.method,
      url: details.url,
      origin: parsed?.origin || "",
      host: parsed?.host || "",
      path: parsed ? `${parsed.pathname || "/"}${parsed.search || ""}` : "",
      pathName: parsed?.pathname || "",
      query: parsed?.search || "",
      hasBody: !!details.requestBody,
      bodyError: details.requestBody?.error || ""
    },
    response: {},
    status: "pending",
    startedAt: details.timeStamp,
    startedAtIso: new Date(details.timeStamp).toISOString(),
    updatedAt: Date.now()
  };

  await upsertEntry(details.requestId, entry);
}

async function handleBeforeSendHeaders(details) {
  if (!activeCapture) return;
  await patchExistingEntry(details.requestId, {
    requestHeaders: serializeHeaders(details.requestHeaders)
  });
}

async function handleHeadersReceived(details) {
  if (!activeCapture) return;
  const contentType = getHeader(details.responseHeaders, "content-type");
  await patchExistingEntry(details.requestId, {
    response: {
      statusCode: details.statusCode,
      statusLine: details.statusLine || "",
      contentType
    },
    responseHeaders: serializeHeaders(details.responseHeaders)
  });
}

async function finalizeRequest(details, status, error = "") {
  if (!activeCapture) return;
  await ensureStoppedIfExpired();
  if (!activeCapture) return;

  const captureId = activeCapture.captureId;
  const detailMap = await readCaptureDetails(captureId);
  const entry = detailMap[details.requestId];
  if (!entry) return;

  const finishedAt = details.timeStamp || Date.now();
  const finalEntry = {
    ...entry,
    status,
    error,
    response: {
      ...(entry.response || {}),
      statusCode: details.statusCode ?? entry.response?.statusCode,
      statusLine: details.statusLine || entry.response?.statusLine || "",
      contentType: getHeader(details.responseHeaders, "content-type") || entry.response?.contentType || ""
    },
    responseHeaders: details.responseHeaders ? serializeHeaders(details.responseHeaders) : entry.responseHeaders,
    finishedAt,
    finishedAtIso: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, Math.round(finishedAt - Number(entry.startedAt || finishedAt))),
    updatedAt: Date.now()
  };

  if (!responseMatchesFilters(finalEntry, activeCapture)) {
    await removeEntry(details.requestId);
    return;
  }

  detailMap[details.requestId] = finalEntry;
  const values = Object.values(detailMap);
  if (values.length > MAX_CAPTURE_EVENTS) {
    values.sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0));
    const removeCount = values.length - MAX_CAPTURE_EVENTS;
    for (const item of values.slice(0, removeCount)) {
      delete detailMap[item.webRequestId];
    }
  }
  await writeCaptureDetails(captureId, detailMap);

  const index = await readCaptureIndex(captureId);
  const requests = Object.values(detailMap)
    .filter(item => item.status !== "pending")
    .sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0))
    .map(item => ({
      uuid: item.uuid,
      endpoint: `${item.request?.method || ""} ${item.request?.origin || ""}${item.request?.pathName || ""}`.trim(),
      method: item.request?.method || "",
      url: item.request?.url || "",
      host: item.request?.host || "",
      path: item.request?.path || "",
      type: item.type || "",
      status: item.status,
      statusCode: item.response?.statusCode ?? null,
      contentType: item.response?.contentType || "",
      durationMs: item.durationMs ?? null,
      tabId: item.tabId,
      startedAt: item.startedAtIso || ""
    }));
  await writeCaptureIndex(captureId, { ...index, captureId, requests, updatedAt: Date.now() });
}

function handleCompleted(details) {
  void finalizeRequest(details, "completed");
}

function handleErrorOccurred(details) {
  void finalizeRequest(details, "error", details.error || "request failed");
}

export async function startNetworkCapture(args = {}) {
  addListeners();
  await ensureStoppedIfExpired();
  if (activeCapture) {
    return {
      error: "network capture is already active",
      captureId: activeCapture.captureId,
      startedAt: activeCapture.startedAtIso,
      expiresAt: activeCapture.expiresAtIso
    };
  }

  const filters = normalizeFilters(args.filters || args);
  if (filters.error) return { error: filters.error };
  const scope = normalizeScope(args.scope);
  const targetTab = scope === "active_tab" ? await resolveActiveHttpTab() : null;
  if (scope === "active_tab" && !targetTab) {
    return {
      error: "No active HTTP/HTTPS tab found for active_tab scope",
      hint: "Open or focus a normal http(s) page, or pass scope: \"all\" to capture matching requests from all tabs."
    };
  }

  const durationSeconds = Math.max(
    1,
    Math.min(300, Math.floor(Number(args.durationSeconds) || DEFAULT_CAPTURE_DURATION_MS / 1000))
  );
  const startedAt = Date.now();
  const expiresAt = Math.min(startedAt + MAX_CAPTURE_DURATION_MS, startedAt + durationSeconds * 1000);
  const captureId = makeId("cap");
  activeCapture = {
    captureId,
    startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    expiresAt,
    expiresAtIso: new Date(expiresAt).toISOString(),
    scope,
    targetTab,
    filters,
    maxEvents: MAX_CAPTURE_EVENTS
  };

  await writeCaptureDetails(captureId, {});
  await writeCaptureIndex(captureId, {
    captureId,
    status: "active",
    startedAt,
    startedAtIso: activeCapture.startedAtIso,
    expiresAt,
    expiresAtIso: activeCapture.expiresAtIso,
    scope,
    targetTab,
    filters: sanitizeFiltersForStorage(filters),
    requests: []
  });
  await persistActiveCapture();
  scheduleCleanup(captureId, expiresAt);

  return {
    success: true,
    captureId,
    startedAt: activeCapture.startedAtIso,
    expiresAt: activeCapture.expiresAtIso,
    scope,
    targetTab,
    maxDurationSeconds: 300,
    filters: sanitizeFiltersForStorage(filters)
  };
}

export async function stopNetworkCapture({ captureId, reason = "stopped" } = {}) {
  if (!activeCapture) {
    if (captureId) {
      const index = await readCaptureIndex(captureId);
      return {
        success: true,
        captureId,
        alreadyStopped: true,
        count: index.requests?.length || 0,
        requests: index.requests || []
      };
    }
    return { success: true, alreadyStopped: true, count: 0, requests: [] };
  }

  if (captureId && captureId !== activeCapture.captureId) {
    return { error: `active capture is ${activeCapture.captureId}, not ${captureId}` };
  }

  const stoppedCapture = activeCapture;
  activeCapture = null;
  await persistActiveCapture();

  const index = await readCaptureIndex(stoppedCapture.captureId);
  const stoppedAt = Date.now();
  const updatedIndex = {
    ...index,
    status: reason === "expired" ? "expired" : "stopped",
    stoppedAt,
    stoppedAtIso: new Date(stoppedAt).toISOString(),
    requests: index.requests || []
  };
  await writeCaptureIndex(stoppedCapture.captureId, updatedIndex);
  scheduleCleanup(stoppedCapture.captureId, stoppedAt + 60 * 1000);

  return {
    success: true,
    captureId: stoppedCapture.captureId,
    stoppedAt: updatedIndex.stoppedAtIso,
    expired: reason === "expired",
    count: updatedIndex.requests.length,
    requests: updatedIndex.requests
  };
}

export async function getNetworkCaptureDetails({ captureId, uuids } = {}) {
  const id = String(captureId || "").trim();
  if (!id) return { error: "captureId is required" };
  const uuidList = Array.isArray(uuids)
    ? uuids.map(uuid => String(uuid || "").trim()).filter(Boolean).slice(0, MAX_DETAIL_QUERY)
    : [];
  if (!uuidList.length) return { error: "uuids is required and must be a non-empty array" };

  const details = await readCaptureDetails(id);
  const byUuid = new Map(Object.values(details).map(item => [item.uuid, item]));
  const requests = uuidList.map(uuid => byUuid.get(uuid) || { uuid, error: "not found" });
  return {
    success: true,
    captureId: id,
    count: requests.filter(item => !item.error).length,
    requests
  };
}

export async function handleNetworkCaptureMessage(action, payload = {}) {
  switch (action) {
    case "start":
      return startNetworkCapture(payload);
    case "stop":
      return stopNetworkCapture(payload);
    case "get_details":
      return getNetworkCaptureDetails(payload);
    default:
      return { success: false, error: `Unknown network capture action: ${action}` };
  }
}

export async function initializeNetworkCapture() {
  addListeners();
  const result = await chrome.storage.local.get({ [ACTIVE_CAPTURE_KEY]: null });
  const saved = result[ACTIVE_CAPTURE_KEY];
  if (!saved) return;
  activeCapture = {
    ...saved,
    filters: hydrateFiltersFromStorage(saved.filters)
  };
  if (isExpired(activeCapture)) {
    await stopNetworkCapture({ reason: "expired" });
  } else {
    scheduleCleanup(activeCapture.captureId, activeCapture.expiresAt + 60 * 1000);
  }
}

export async function cleanupNetworkCapture(captureId) {
  const id = String(captureId || "").trim();
  if (!id) return;
  if (activeCapture?.captureId === id) {
    activeCapture = null;
    await persistActiveCapture();
  }
  await chrome.storage.local.remove([indexKey(id), detailsKey(id)]);
}

export function isNetworkCaptureCleanupAlarm(name) {
  return String(name || "").startsWith(CLEANUP_ALARM_PREFIX);
}

export function getNetworkCaptureIdFromCleanupAlarm(name) {
  return String(name || "").slice(CLEANUP_ALARM_PREFIX.length);
}

export const NETWORK_CAPTURE_STORAGE_KEYS = {
  ACTIVE_CAPTURE_KEY,
  CAPTURE_INDEX_PREFIX,
  CAPTURE_DETAILS_PREFIX
};
