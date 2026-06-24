import { normalizeStashMap } from "./snapshot";

export function buildStashIndex(stashes = {}, tombstones = {}) {
  const normalized = normalizeStashMap(stashes);
  const index = {};
  for (const [title, stash] of Object.entries(normalized)) {
    index[title] = {
      id: getStashItemId(title),
      updatedAt: Number(stash.updatedAt) || 0
    };
  }
  for (const [title, tombstone] of Object.entries(tombstones || {})) {
    const deletedAt = Number(tombstone?.deletedAt || tombstone);
    if (!title || !Number.isFinite(deletedAt) || deletedAt <= 0) continue;
    const current = index[title];
    if (!current || deletedAt >= Number(current.updatedAt || 0)) {
      index[title] = {
        id: getStashItemId(title),
        updatedAt: deletedAt,
        deletedAt
      };
    }
  }
  return {
    schemaVersion: 1,
    namespace: "stash-index",
    items: index
  };
}

export function mergeStashIndexes(localIndex, remoteIndex) {
  const result = {};
  const localItems = localIndex?.items && typeof localIndex.items === "object" ? localIndex.items : {};
  const remoteItems = remoteIndex?.items && typeof remoteIndex.items === "object" ? remoteIndex.items : {};
  const titles = new Set([...Object.keys(localItems), ...Object.keys(remoteItems)]);
  for (const title of titles) {
    const local = normalizeIndexEntry(title, localItems[title]);
    const remote = normalizeIndexEntry(title, remoteItems[title]);
    if (!local && !remote) continue;
    const winner = Number(local?.updatedAt || 0) >= Number(remote?.updatedAt || 0) ? local : remote;
    result[title] = winner;
  }
  return {
    schemaVersion: 1,
    namespace: "stash-index",
    items: result
  };
}

export function areStashIndexesEqual(a, b) {
  const aItems = a?.items && typeof a.items === "object" ? a.items : {};
  const bItems = b?.items && typeof b.items === "object" ? b.items : {};
  const titles = new Set([...Object.keys(aItems), ...Object.keys(bItems)]);
  for (const title of titles) {
    const aEntry = normalizeIndexEntry(title, aItems[title]);
    const bEntry = normalizeIndexEntry(title, bItems[title]);
    if (!aEntry && !bEntry) continue;
    if (!sameNormalizedIndexEntry(aEntry, bEntry)) return false;
  }
  return true;
}

export function getChangedStashIndexEntries(localIndex, remoteIndex) {
  const localItems = localIndex?.items && typeof localIndex.items === "object" ? localIndex.items : {};
  const remoteItems = remoteIndex?.items && typeof remoteIndex.items === "object" ? remoteIndex.items : {};
  const titles = new Set([...Object.keys(localItems), ...Object.keys(remoteItems)]);
  const changed = [];
  for (const title of titles) {
    const local = normalizeIndexEntry(title, localItems[title]);
    const remote = normalizeIndexEntry(title, remoteItems[title]);
    if (!local && !remote) continue;
    if (Number(local?.updatedAt || 0) !== Number(remote?.updatedAt || 0) || Number(local?.deletedAt || 0) !== Number(remote?.deletedAt || 0)) {
      changed.push({ title, local, remote });
    }
  }
  return changed;
}

export function buildStashItemDocument(title, stash, deviceId = "") {
  return {
    schemaVersion: 1,
    namespace: "stash-item",
    deviceId,
    title,
    updatedAt: Number(stash?.updatedAt) || Date.now(),
    stash
  };
}

export function getStashItemId(title) {
  return bytesToHex(new TextEncoder().encode(String(title || "")));
}

function normalizeIndexEntry(title, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = String(entry.id || getStashItemId(title));
  const updatedAt = Number(entry.updatedAt) || Number(entry.deletedAt) || 0;
  if (!updatedAt) return null;
  const result = { id, updatedAt };
  const deletedAt = Number(entry.deletedAt) || 0;
  if (deletedAt > 0) result.deletedAt = deletedAt;
  return result;
}

function sameNormalizedIndexEntry(a, b) {
  if (!a || !b) return false;
  return String(a.id || "") === String(b.id || "")
    && Number(a.updatedAt || 0) === Number(b.updatedAt || 0)
    && Number(a.deletedAt || 0) === Number(b.deletedAt || 0);
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
