import { normalizeStashMap } from "./snapshot";

const SETTINGS_FIELD_KEYS = [
  "llmConfig",
  "mcpToolTimeoutSeconds",
  "reuse",
  "extractTextLimit",
  "betaFeaturesEnabled",
  "hideCopyButton",
  "dangerousToolSkipApproval",
  "postdogToolsEnabled"
];

export function mergeSettingsSnapshots(localSettings, remoteSnapshot, { deviceId = "", preferLocal = false } = {}) {
  const remoteSettings = remoteSnapshot?.settings && typeof remoteSnapshot.settings === "object"
    ? remoteSnapshot.settings
    : {};
  const localUpdatedAt = Number(localSettings?.updatedAt) || 0;
  const remoteUpdatedAt = Number(remoteSnapshot?.updatedAt) || 0;
  const useLocal = preferLocal || localUpdatedAt >= remoteUpdatedAt;
  const merged = {};

  for (const key of SETTINGS_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(localSettings || {}, key) && useLocal) {
      merged[key] = localSettings[key];
    } else if (Object.prototype.hasOwnProperty.call(remoteSettings, key) && !useLocal) {
      merged[key] = remoteSettings[key];
    } else if (Object.prototype.hasOwnProperty.call(localSettings || {}, key)) {
      merged[key] = localSettings[key];
    } else if (Object.prototype.hasOwnProperty.call(remoteSettings, key)) {
      merged[key] = remoteSettings[key];
    }
  }

  return {
    schemaVersion: 1,
    namespace: "settings",
    deviceId,
    updatedAt: Math.max(Date.now(), localUpdatedAt, remoteUpdatedAt),
    settings: merged
  };
}

export function mergeStashSnapshots(localStashes, remoteSnapshot, tombstones = {}, { deviceId = "" } = {}) {
  const remoteStashes = normalizeStashMap(remoteSnapshot?.stashes);
  const local = normalizeStashMap(localStashes);
  const merged = {};
  const nextTombstones = normalizeTombstones(tombstones);
  const titles = new Set([
    ...Object.keys(local),
    ...Object.keys(remoteStashes),
    ...Object.keys(nextTombstones)
  ]);

  for (const title of titles) {
    const localItem = local[title] || null;
    const remoteItem = remoteStashes[title] || null;
    const deletedAt = Number(nextTombstones[title]?.deletedAt) || 0;
    const localUpdatedAt = Number(localItem?.updatedAt) || 0;
    const remoteUpdatedAt = Number(remoteItem?.updatedAt) || 0;

    if (deletedAt >= localUpdatedAt && deletedAt >= remoteUpdatedAt) {
      continue;
    }

    const winner = localUpdatedAt >= remoteUpdatedAt ? localItem : remoteItem;
    if (winner) {
      merged[title] = winner;
      delete nextTombstones[title];
    }
  }

  return {
    snapshot: {
      schemaVersion: 1,
      namespace: "stash",
      deviceId,
      updatedAt: Date.now(),
      stashes: merged
    },
    tombstones: nextTombstones
  };
}

export function updateStashTombstones(previousStashes = {}, nextStashes = {}, tombstones = {}) {
  const previous = normalizeStashMap(previousStashes);
  const next = normalizeStashMap(nextStashes);
  const result = normalizeTombstones(tombstones);
  const now = Date.now();
  for (const title of Object.keys(previous)) {
    if (!Object.prototype.hasOwnProperty.call(next, title)) {
      result[title] = { deletedAt: now };
    }
  }
  return result;
}

export function normalizeTombstones(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [title, item] of Object.entries(value)) {
    const deletedAt = Number(item?.deletedAt || item);
    if (title && Number.isFinite(deletedAt) && deletedAt > 0) {
      result[title] = { deletedAt };
    }
  }
  return result;
}
