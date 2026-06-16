/* global chrome */
import { STASH_STORAGE_KEY } from "../llm/core/constants";
import {
  GITHUB_SYNC_CONFIG_KEY,
  GITHUB_SYNC_DEFAULT_STATE,
  GITHUB_SYNC_STATE_KEY,
  GITHUB_SYNC_TOMBSTONES_KEY,
  getStashIndexFilePath,
  getStashItemFilePath,
  getSyncFilePath,
  hasUsableGithubSyncConfig,
  normalizeGithubSyncConfig,
  normalizeGithubSyncState
} from "./config";
import { getGithubSyncFile, putGithubSyncFile } from "./githubClient";
import {
  applySettingsSnapshot,
  applyStashSnapshot,
  readLocalSettingsForMerge,
  readLocalStashesForMerge
} from "./snapshot";
import {
  mergeSettingsSnapshots,
  updateStashTombstones
} from "./merge";
import {
  buildStashIndex,
  buildStashItemDocument,
  getStashItemId,
  mergeStashIndexes
} from "./stashItems";

const SETTINGS_DIRTY_KEYS = new Set([
  "llmConfig",
  "mcpToolTimeoutSeconds",
  "reuse",
  "extractTextLimit",
  "betaFeaturesEnabled",
  "hideCopyButton",
  "dangerousToolSkipApproval"
]);

let suppressDirtyMark = false;

export async function getGithubSyncStatus() {
  const res = await chrome.storage.local.get({
    [GITHUB_SYNC_CONFIG_KEY]: {},
    [GITHUB_SYNC_STATE_KEY]: GITHUB_SYNC_DEFAULT_STATE
  });
  return {
    config: normalizeGithubSyncConfig(res[GITHUB_SYNC_CONFIG_KEY]),
    state: normalizeGithubSyncState(res[GITHUB_SYNC_STATE_KEY])
  };
}

export async function saveGithubSyncConfig(config) {
  const normalized = normalizeGithubSyncConfig(config);
  const state = await ensureGithubSyncDeviceId();
  await chrome.storage.local.set({
    [GITHUB_SYNC_CONFIG_KEY]: normalized,
    [GITHUB_SYNC_STATE_KEY]: {
      ...state,
      lastError: ""
    }
  });
  return normalized;
}

export async function ensureGithubSyncDeviceId() {
  const res = await chrome.storage.local.get({ [GITHUB_SYNC_STATE_KEY]: GITHUB_SYNC_DEFAULT_STATE });
  const state = normalizeGithubSyncState(res[GITHUB_SYNC_STATE_KEY]);
  if (state.deviceId) return state;
  const next = { ...state, deviceId: createDeviceId() };
  await chrome.storage.local.set({ [GITHUB_SYNC_STATE_KEY]: next });
  return next;
}

export async function markGithubSyncDirtyFromStorageChanges(changes, areaName) {
  if (suppressDirtyMark) return;
  if (areaName !== "local" || !changes || changes[GITHUB_SYNC_STATE_KEY]) return;
  const status = await getGithubSyncStatus();
  if (!status.config.enabled) return;

  const patch = {};
  if (status.config.syncSettings && Object.keys(changes).some(key => SETTINGS_DIRTY_KEYS.has(key))) {
    patch.dirtySettings = true;
  }
  if (status.config.syncStash && changes[STASH_STORAGE_KEY]) {
    patch.dirtyStash = true;
    const previous = changes[STASH_STORAGE_KEY].oldValue || {};
    const next = changes[STASH_STORAGE_KEY].newValue || {};
    const res = await chrome.storage.local.get({ [GITHUB_SYNC_TOMBSTONES_KEY]: {} });
    await patchTombstones(updateStashTombstones(previous, next, res[GITHUB_SYNC_TOMBSTONES_KEY]));
  }
  if (Object.keys(patch).length === 0) return;
  await patchGithubSyncState(patch);
}

export async function runGithubSync({ force = false } = {}) {
  const { config } = await getGithubSyncStatus();
  if (!hasUsableGithubSyncConfig(config)) {
    throw new Error("GitHub 同步未启用或配置不完整");
  }

  let state = await ensureGithubSyncDeviceId();
  if (state.inProgress) {
    return { skipped: true, reason: "in_progress" };
  }
  await patchGithubSyncState({ inProgress: true, lastError: "" });

  try {
    const namespaces = [];
    if (config.syncSettings) namespaces.push("settings");
    if (config.syncStash) namespaces.push("stash");
    if (namespaces.length === 0) throw new Error("至少需要开启一种同步数据");

    const results = {};
    state = normalizeGithubSyncState((await chrome.storage.local.get({ [GITHUB_SYNC_STATE_KEY]: GITHUB_SYNC_DEFAULT_STATE }))[GITHUB_SYNC_STATE_KEY]);
    for (const namespace of namespaces) {
      if (namespace === "settings" && !state.dirtySettings) {
        results[namespace] = await pullGithubSyncNamespace(config, state, namespace);
      } else if (namespace === "stash" && !state.dirtyStash) {
        results[namespace] = await pullGithubSyncNamespace(config, state, namespace);
      } else {
        results[namespace] = await mergeAndPushGithubSyncNamespace(config, state, namespace);
      }
      state = normalizeGithubSyncState((await chrome.storage.local.get({ [GITHUB_SYNC_STATE_KEY]: GITHUB_SYNC_DEFAULT_STATE }))[GITHUB_SYNC_STATE_KEY]);
    }

    await patchGithubSyncState({ inProgress: false, lastSyncAt: Date.now(), lastError: "" });
    return { success: true, results };
  } catch (error) {
    await patchGithubSyncState({ inProgress: false, lastError: error?.message || String(error) });
    throw error;
  }
}

async function pullGithubSyncNamespace(config, state, namespace) {
  if (namespace === "stash") {
    return await syncStashItems(config, state);
  }

  const path = getSyncFilePath(config, namespace);
  const remote = await getGithubSyncFile(config, path);
  if (!remote) {
    return await mergeAndPushGithubSyncNamespace(config, state, namespace);
  }

  if (namespace === "settings") {
    await applyWithoutDirtyMark(() => applySettingsSnapshot(remote.content));
    await patchGithubSyncState({
      remoteShas: { ...state.remoteShas, [namespace]: remote.sha }
    });
    return { action: "pulled", sha: remote.sha };
  }

  return { action: "ignored" };
}

async function mergeAndPushGithubSyncNamespace(config, state, namespace) {
  if (namespace === "stash") {
    return await syncStashItems(config, state);
  }

  const path = getSyncFilePath(config, namespace);
  let remote = await getGithubSyncFile(config, path);
  const merged = await buildMergedSnapshot(namespace, remote?.content, state.deviceId, { preferLocal: true });
  const put = await putWithConflictRetry(config, path, merged.snapshot, remote?.sha || "", async (latestRemote) => {
    return (await buildMergedSnapshot(namespace, latestRemote?.content, state.deviceId, { preferLocal: true })).snapshot;
  });

  if (namespace === "settings") {
    await applyWithoutDirtyMark(() => applySettingsSnapshot(merged.snapshot));
  }

  await patchGithubSyncState({
    dirtySettings: namespace === "settings" ? false : state.dirtySettings,
    dirtyStash: namespace === "stash" ? false : state.dirtyStash,
    remoteShas: { ...state.remoteShas, [namespace]: put.sha }
  });
  return { action: remote ? "merged_pushed" : "created", sha: put.sha };
}

async function buildMergedSnapshot(namespace, remoteSnapshot, deviceId, options = {}) {
  if (namespace === "settings") {
    const localSettings = await readLocalSettingsForMerge();
    return {
      snapshot: mergeSettingsSnapshots(localSettings, remoteSnapshot, { deviceId, preferLocal: options.preferLocal === true })
    };
  }
  throw new Error(`Unknown sync namespace: ${namespace}`);
}

async function putWithConflictRetry(config, path, snapshot, sha, buildSnapshotFromRemote) {
  try {
    return await putGithubSyncFile(config, path, snapshot, { sha });
  } catch (error) {
    if (error?.status !== 409) throw error;
    const latestRemote = await getGithubSyncFile(config, path);
    const nextSnapshot = await buildSnapshotFromRemote(latestRemote?.content || null);
    return await putGithubSyncFile(config, path, nextSnapshot, { sha: latestRemote?.sha || "" });
  }
}

export async function patchGithubSyncState(patch) {
  const res = await chrome.storage.local.get({ [GITHUB_SYNC_STATE_KEY]: GITHUB_SYNC_DEFAULT_STATE });
  const current = normalizeGithubSyncState(res[GITHUB_SYNC_STATE_KEY]);
  await chrome.storage.local.set({
    [GITHUB_SYNC_STATE_KEY]: {
      ...current,
      ...patch,
      remoteShas: patch.remoteShas || current.remoteShas
    }
  });
}

async function patchTombstones(tombstones) {
  await chrome.storage.local.set({ [GITHUB_SYNC_TOMBSTONES_KEY]: tombstones });
}

function createDeviceId() {
  if (globalThis.crypto?.randomUUID) return `dev_${globalThis.crypto.randomUUID()}`;
  return `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function applyWithoutDirtyMark(fn) {
  suppressDirtyMark = true;
  try {
    return await fn();
  } finally {
    suppressDirtyMark = false;
  }
}

async function syncStashItems(config, state) {
  const indexPath = getStashIndexFilePath(config);
  let remoteIndexFile = await getGithubSyncFile(config, indexPath);
  if (!remoteIndexFile) {
    remoteIndexFile = await migrateLegacyStashSnapshotToIndex(config);
  }
  const remoteIndex = remoteIndexFile?.content || { schemaVersion: 1, namespace: "stash-index", items: {} };
  const localStashes = await readLocalStashesForMerge();
  const tombstoneRes = await chrome.storage.local.get({ [GITHUB_SYNC_TOMBSTONES_KEY]: {} });
  const localIndex = buildStashIndex(localStashes, tombstoneRes[GITHUB_SYNC_TOMBSTONES_KEY]);
  const mergedIndex = mergeStashIndexes(localIndex, remoteIndex);

  const nextStashes = { ...localStashes };
  const nextTombstones = {};
  const itemShas = {};

  for (const [title, mergedEntry] of Object.entries(mergedIndex.items || {})) {
    const localEntry = localIndex.items?.[title] || null;
    const remoteEntry = remoteIndex.items?.[title] || null;
    const itemId = mergedEntry.id || localEntry?.id || remoteEntry?.id || getStashItemId(title);
    const itemPath = getStashItemFilePath(config, itemId);

    if (mergedEntry.deletedAt) {
      delete nextStashes[title];
      nextTombstones[title] = { deletedAt: mergedEntry.deletedAt };
      continue;
    }

    const localWins = sameIndexEntry(localEntry, mergedEntry) && localStashes[title];
    const remoteWins = sameIndexEntry(remoteEntry, mergedEntry);

    if (remoteWins && !localWins) {
      const remoteItem = await getGithubSyncFile(config, itemPath);
      itemShas[itemId] = remoteItem?.sha || "";
      const remoteStash = normalizeRemoteStashItem(remoteItem?.content, title);
      if (remoteStash) {
        nextStashes[title] = remoteStash;
        continue;
      }
    }

    if (localStashes[title]) {
      const remoteItem = remoteEntry && !remoteWins ? await getGithubSyncFile(config, itemPath) : null;
      const sha = remoteItem?.sha || itemShas[itemId] || "";
      await putGithubSyncFile(config, itemPath, buildStashItemDocument(title, localStashes[title], state.deviceId), { sha });
      nextStashes[title] = localStashes[title];
    }
  }

  await applyWithoutDirtyMark(async () => {
    await applyStashSnapshot({ stashes: nextStashes });
    await chrome.storage.local.set({ [GITHUB_SYNC_TOMBSTONES_KEY]: nextTombstones });
  });

  const put = await putStashIndexWithConflictRetry(config, indexPath, mergedIndex, remoteIndexFile?.sha || "", state);
  await patchGithubSyncState({
    dirtyStash: false,
    remoteShas: { ...state.remoteShas, stash: put.sha }
  });
  return { action: remoteIndexFile ? "merged_items" : "created_items", sha: put.sha };
}

async function migrateLegacyStashSnapshotToIndex(config) {
  let legacy;
  try {
    legacy = await getGithubSyncFile(config, getSyncFilePath(config, "stash"));
  } catch (error) {
    console.warn("Ignoring unreadable legacy GitHub stash sync file:", error);
    return null;
  }
  if (!legacy?.content?.stashes) return null;
  const legacyIndex = buildStashIndex(legacy.content.stashes, {});
  const indexPath = getStashIndexFilePath(config);
  for (const [title, stash] of Object.entries(legacy.content.stashes || {})) {
    const itemId = legacyIndex.items?.[title]?.id || getStashItemId(title);
    await putGithubSyncFile(config, getStashItemFilePath(config, itemId), buildStashItemDocument(title, stash, "legacy-migration"), { sha: "" });
  }
  const put = await putGithubSyncFile(config, indexPath, legacyIndex, { sha: "" });
  return { sha: put.sha, content: legacyIndex };
}

async function putStashIndexWithConflictRetry(config, path, index, sha, state) {
  try {
    return await putGithubSyncFile(config, path, index, { sha });
  } catch (error) {
    if (error?.status !== 409) throw error;
    const latest = await getGithubSyncFile(config, path);
    const localStashes = await readLocalStashesForMerge();
    const tombstoneRes = await chrome.storage.local.get({ [GITHUB_SYNC_TOMBSTONES_KEY]: {} });
    const localIndex = buildStashIndex(localStashes, tombstoneRes[GITHUB_SYNC_TOMBSTONES_KEY]);
    const mergedIndex = mergeStashIndexes(localIndex, latest?.content || { items: {} });
    return await putGithubSyncFile(config, path, mergedIndex, { sha: latest?.sha || "" });
  } finally {
    void state;
  }
}

function sameIndexEntry(a, b) {
  if (!a || !b) return false;
  return String(a.id || "") === String(b.id || "")
    && Number(a.updatedAt || 0) === Number(b.updatedAt || 0)
    && Number(a.deletedAt || 0) === Number(b.deletedAt || 0);
}

function normalizeRemoteStashItem(content, expectedTitle) {
  if (!content || typeof content !== "object") return null;
  if (String(content.title || "") !== String(expectedTitle || "")) return null;
  const stash = content.stash;
  if (!stash || typeof stash !== "object" || Array.isArray(stash)) return null;
  return {
    info: String(stash.info ?? ""),
    expireAt: Number.isFinite(Number(stash.expireAt)) ? Number(stash.expireAt) : -1,
    createdAt: Number(stash.createdAt) || Number(stash.updatedAt) || Date.now(),
    updatedAt: Number(stash.updatedAt) || Number(stash.createdAt) || Date.now()
  };
}
