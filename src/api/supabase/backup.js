/* global chrome */
import { exportSettingsBackup, importSettingsBackupFromText, SETTINGS_BACKUP_KEYS } from "../settings/backup";
import { getSupabasePath, loadSupabaseConfig } from "./config";
import { downloadSupabaseObject, uploadSupabaseObject } from "./storage";

const MANIFEST_FILE = "manifest.json";
const SETTINGS_FILE = "settings.json";
export const SUPABASE_SETTINGS_SYNC_STATE_KEY = "supabaseSettingsSyncState";

export async function syncSessionsWithSupabase() {
  const config = await loadSupabaseConfig();
  const { sessions_index = [] } = await chrome.storage.local.get({ sessions_index: [] });
  const remoteManifest = await loadRemoteManifest(config, { allowMissing: true });
  const localEntries = new Map(sessions_index.map(entry => [String(entry?.id || ""), entry]).filter(([id]) => id));
  const remoteEntries = remoteManifest.sessions || {};
  const allIds = new Set([...localEntries.keys(), ...Object.keys(remoteEntries)]);
  const manifest = emptyManifest();
  const mergedEntries = new Map(localEntries);
  const localPatch = {};
  let uploadedCount = 0;
  let downloadedCount = 0;
  let unchangedCount = 0;

  for (const id of allIds) {
    const localEntry = localEntries.get(id);
    const remoteMeta = remoteEntries[id];
    const localUpdatedAt = normalizeUpdatedAt(localEntry?.updatedAt);
    const remoteUpdatedAt = normalizeUpdatedAt(remoteMeta?.updatedAt);
    const path = remoteMeta?.path || getSupabasePath(config, "sessions", `${id}.json`);

    if (!localEntry || remoteUpdatedAt > localUpdatedAt) {
      const payload = await downloadSessionPayload(path, config);
      if (!payload?.entry || !payload?.session) throw new Error(`远端会话 ${id} 格式无效`);
      const restoredEntry = { ...payload.entry, id };
      mergedEntries.set(id, restoredEntry);
      localPatch[`session_${id}`] = payload.session;
      localPatch[`session_${id}_images`] = payload.images || {};
      manifest.sessions[id] = { path, updatedAt: normalizeUpdatedAt(restoredEntry.updatedAt) };
      downloadedCount += 1;
      continue;
    }

    if (!remoteMeta || localUpdatedAt > remoteUpdatedAt) {
      const keys = [`session_${id}`, `session_${id}_images`];
      const values = await chrome.storage.local.get(keys);
      const payload = { entry: localEntry, session: values[keys[0]] || {}, images: values[keys[1]] || {} };
      await uploadSupabaseObject(path, JSON.stringify(payload), { config, contentType: "application/json;charset=utf-8" });
      manifest.sessions[id] = { path, updatedAt: localUpdatedAt };
      uploadedCount += 1;
      continue;
    }

    manifest.sessions[id] = { path, updatedAt: remoteUpdatedAt };
    unchangedCount += 1;
  }

  const nextIndex = Array.from(mergedEntries.values())
    .sort((a, b) => (normalizeUpdatedAt(b.startedAt) || normalizeUpdatedAt(b.updatedAt)) - (normalizeUpdatedAt(a.startedAt) || normalizeUpdatedAt(a.updatedAt)));
  await chrome.storage.local.set({ ...localPatch, sessions_index: nextIndex });
  await uploadSupabaseObject(getSupabasePath(config, "sessions", MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
    config,
    contentType: "application/json;charset=utf-8"
  });
  return { total: allIds.size, uploadedCount, downloadedCount, unchangedCount };
}

export async function restoreSettingsFromSupabase() {
  const config = await loadSupabaseConfig();
  const remoteSettings = await downloadSettingsPayload(config);
  validateRemoteSettings(remoteSettings);
  await replaceLocalSettings(remoteSettings);
  return { updatedKeyCount: Object.keys(remoteSettings.backup?.settings || {}).length };
}

export async function overwriteSupabaseSettingsFromLocal() {
  const config = await loadSupabaseConfig();
  await uploadLocalSettings(config);
}

export async function markSupabaseSettingsDirtyFromStorageChanges(changes, areaName) {
  if (areaName !== "local" || !Object.keys(changes || {}).some(key => SETTINGS_BACKUP_KEYS.includes(key))) return;
  const current = await loadSettingsSyncState();
  if (Number(current.suppressDirtyUntil) > Date.now()) return;
  await chrome.storage.local.set({
    [SUPABASE_SETTINGS_SYNC_STATE_KEY]: { ...current, updatedAt: Date.now(), suppressDirtyUntil: 0 }
  });
}

async function replaceLocalSettings(remote) {
  validateRemoteSettings(remote);
  const remoteUpdatedAt = normalizeUpdatedAt(remote.updatedAt) || Date.now();
  await chrome.storage.local.set({
    [SUPABASE_SETTINGS_SYNC_STATE_KEY]: { updatedAt: remoteUpdatedAt, suppressDirtyUntil: Date.now() + 10000 }
  });
  await chrome.storage.local.remove(SETTINGS_BACKUP_KEYS);
  await importSettingsBackupFromText(JSON.stringify(remote.backup));
  await chrome.storage.local.set({
    [SUPABASE_SETTINGS_SYNC_STATE_KEY]: { updatedAt: remoteUpdatedAt, suppressDirtyUntil: Date.now() + 10000 }
  });
}

function validateRemoteSettings(remote) {
  if (remote?.format !== "tab-manager-supabase-settings" || !remote.backup) {
    throw new Error("远端设置备份格式无效");
  }
}

async function uploadLocalSettings(config) {
  const updatedAt = Date.now();
  const payload = { format: "tab-manager-supabase-settings", version: 1, updatedAt, backup: await exportSettingsBackup() };
  await uploadSupabaseObject(getSupabasePath(config, "config", SETTINGS_FILE), JSON.stringify(payload, null, 2), {
    config,
    contentType: "application/json;charset=utf-8"
  });
  await chrome.storage.local.set({ [SUPABASE_SETTINGS_SYNC_STATE_KEY]: { updatedAt, suppressDirtyUntil: 0 } });
}

async function downloadSessionPayload(path, config) {
  return (await downloadSupabaseObject(path, { config })).json();
}

async function downloadSettingsPayload(config) {
  return (await downloadSupabaseObject(getSupabasePath(config, "config", SETTINGS_FILE), { config })).json();
}

async function loadRemoteManifest(config, { allowMissing = false } = {}) {
  try {
    const manifest = await (await downloadSupabaseObject(getSupabasePath(config, "sessions", MANIFEST_FILE), { config })).json();
    if (manifest?.format !== "tab-manager-sessions" || !manifest.sessions) throw new Error("远端会话备份格式无效");
    return manifest;
  } catch (error) {
    if (allowMissing && error?.status === 404) return emptyManifest();
    throw error;
  }
}

async function loadSettingsSyncState() {
  const result = await chrome.storage.local.get({ [SUPABASE_SETTINGS_SYNC_STATE_KEY]: {} });
  return result[SUPABASE_SETTINGS_SYNC_STATE_KEY] || {};
}

function emptyManifest() {
  return {
    format: "tab-manager-sessions",
    version: 2,
    updatedAt: new Date().toISOString(),
    sessions: {}
  };
}

function normalizeUpdatedAt(value) {
  const updatedAt = Number(value);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
}
