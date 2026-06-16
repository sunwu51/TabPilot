export const GITHUB_SYNC_CONFIG_KEY = "githubSyncConfig";
export const GITHUB_SYNC_STATE_KEY = "githubSyncState";
export const GITHUB_SYNC_TOMBSTONES_KEY = "githubSyncTombstones";
export const GITHUB_SYNC_ALARM_NAME = "github-sync";
export const GITHUB_SYNC_DEFAULT_INTERVAL_MINUTES = 10;
export const GITHUB_SYNC_MIN_INTERVAL_MINUTES = 10;
export const GITHUB_SYNC_IN_PROGRESS_STALE_MS = 10 * 60 * 1000;

export const GITHUB_SYNC_DEFAULT_CONFIG = {
  enabled: false,
  owner: "",
  repo: "",
  branch: "",
  token: "",
  basePath: "tabmanager",
  syncSettings: true,
  syncStash: true,
  intervalMinutes: GITHUB_SYNC_DEFAULT_INTERVAL_MINUTES
};

export const GITHUB_SYNC_DEFAULT_STATE = {
  deviceId: "",
  dirtySettings: false,
  dirtyStash: false,
  lastSyncAt: 0,
  lastError: "",
  inProgress: false,
  inProgressStartedAt: 0,
  remoteShas: {}
};

export function normalizeGithubSyncConfig(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...GITHUB_SYNC_DEFAULT_CONFIG,
    enabled: source.enabled === true,
    owner: String(source.owner || "").trim(),
    repo: String(source.repo || "").trim(),
    branch: String(source.branch || "").trim(),
    token: String(source.token || "").trim(),
    basePath: normalizeBasePath(source.basePath),
    syncSettings: source.syncSettings !== false,
    syncStash: source.syncStash !== false,
    intervalMinutes: normalizeSyncIntervalMinutes(source.intervalMinutes)
  };
}

export function normalizeGithubSyncState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...GITHUB_SYNC_DEFAULT_STATE,
    deviceId: String(source.deviceId || ""),
    dirtySettings: source.dirtySettings === true,
    dirtyStash: source.dirtyStash === true,
    lastSyncAt: Number(source.lastSyncAt) || 0,
    lastError: String(source.lastError || ""),
    inProgress: source.inProgress === true,
    inProgressStartedAt: Number(source.inProgressStartedAt) || 0,
    remoteShas: source.remoteShas && typeof source.remoteShas === "object" && !Array.isArray(source.remoteShas)
      ? source.remoteShas
      : {}
  };
}

export function normalizeBasePath(value) {
  return String(value || "tabmanager")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/") || "tabmanager";
}

export function normalizeSyncIntervalMinutes(value) {
  const minutes = Math.trunc(Number(value) || GITHUB_SYNC_DEFAULT_INTERVAL_MINUTES);
  return Math.max(GITHUB_SYNC_MIN_INTERVAL_MINUTES, minutes);
}

export function getSyncFilePath(config, namespace) {
  const basePath = normalizeBasePath(config?.basePath);
  return `${basePath}/${namespace}.json.deflate.b64`;
}

export function getStashIndexFilePath(config) {
  const basePath = normalizeBasePath(config?.basePath);
  return `${basePath}/stash/index.json.deflate.b64`;
}

export function getStashItemFilePath(config, itemId) {
  const basePath = normalizeBasePath(config?.basePath);
  return `${basePath}/stash/items/${encodeURIComponent(String(itemId || ""))}.json.deflate.b64`;
}

export function hasUsableGithubSyncConfig(config) {
  const normalized = normalizeGithubSyncConfig(config);
  return !!(normalized.enabled && normalized.owner && normalized.repo && normalized.token);
}
