/* global chrome */
import { STASH_STORAGE_KEY } from "../llm/core/constants";
import { exportSettingsBackup, importSettingsBackupFromText } from "../settings/backup";
import { ensureSettingsMigrated } from "../settings/migrations";

export async function buildSettingsSnapshot(deviceId) {
  const backup = await exportSettingsBackup();
  return {
    schemaVersion: 1,
    namespace: "settings",
    deviceId,
    updatedAt: Date.now(),
    settings: backup.settings || {}
  };
}

export async function applySettingsSnapshot(snapshot) {
  const settings = snapshot?.settings && typeof snapshot.settings === "object"
    ? snapshot.settings
    : {};
  if (Object.keys(settings).length === 0) return { updatedKeys: [] };
  return await importSettingsBackupFromText(JSON.stringify({ settings }));
}

export async function buildStashSnapshot(deviceId) {
  const res = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
  const stashes = normalizeStashMap(res[STASH_STORAGE_KEY]);
  return {
    schemaVersion: 1,
    namespace: "stash",
    deviceId,
    updatedAt: Date.now(),
    stashes
  };
}

export async function applyStashSnapshot(snapshot) {
  const stashes = normalizeStashMap(snapshot?.stashes);
  await chrome.storage.local.set({ [STASH_STORAGE_KEY]: stashes });
  return { count: Object.keys(stashes).length };
}

export async function readLocalSettingsForMerge() {
  await ensureSettingsMigrated();
  const backup = await exportSettingsBackup();
  return backup.settings || {};
}

export async function readLocalStashesForMerge() {
  const res = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
  return normalizeStashMap(res[STASH_STORAGE_KEY]);
}

export function normalizeStashMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [title, stash] of Object.entries(value)) {
    if (!stash || typeof stash !== "object" || Array.isArray(stash)) continue;
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) continue;
    const now = Date.now();
    const updatedAt = Number(stash.updatedAt) || Number(stash.createdAt) || now;
    result[normalizedTitle] = {
      info: String(stash.info ?? ""),
      expireAt: Number.isFinite(Number(stash.expireAt)) ? Number(stash.expireAt) : -1,
      createdAt: Number(stash.createdAt) || updatedAt,
      updatedAt
    };
  }
  return result;
}
