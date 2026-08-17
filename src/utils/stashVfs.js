/* global chrome */
import { DEFAULT_STASH_EXPIRE_AT, STASH_STORAGE_KEY } from "../api/llm/core/constants";
import { chromeStorageVfs } from "./chromeStorageVfs";

export const STASH_VFS_DIRECTORY = "/stashes";

function encodeTitle(title) {
  let encoded = "";
  for (let index = 0; index < title.length; index += 1) {
    encoded += title.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

export function getStashVfsPath(title) {
  return `${STASH_VFS_DIRECTORY}/${encodeTitle(title)}.json`;
}

export async function migrateLegacyStashesToVfs() {
  const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
  const legacy = result[STASH_STORAGE_KEY];
  if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) return;

  for (const [title, stash] of Object.entries(legacy)) {
    const path = getStashVfsPath(title);
    if (await chromeStorageVfs.exists(path)) {
      try {
        const current = await chromeStorageVfs.readJson(path);
        if (current?.title === title) continue;
      } catch {
        // Replace corrupt or mismatched migration targets with the legacy value.
      }
    }
    const legacyExpireAt = Number(stash?.expireAt);
    const record = {
      title,
      info: String(stash?.info || ""),
      expireAt: Number.isFinite(legacyExpireAt) ? legacyExpireAt : DEFAULT_STASH_EXPIRE_AT,
      createdAt: Number(stash?.createdAt) || Number(stash?.updatedAt) || Date.now(),
      updatedAt: Number(stash?.updatedAt) || Date.now()
    };
    await chromeStorageVfs.writeJson(path, record, { expireAt: record.expireAt });
  }
  await chrome.storage.local.remove(STASH_STORAGE_KEY);
}

export async function readStashRecordFromVfs(title) {
  await migrateLegacyStashesToVfs();
  const path = getStashVfsPath(title);
  try {
    const result = await chromeStorageVfs.readJsonWithStat(path);
    return { stash: result.value, revision: result.stat.revision, path };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listStashFilesFromVfs() {
  await migrateLegacyStashesToVfs();
  try {
    return (await chromeStorageVfs.readdir(STASH_VFS_DIRECTORY)).filter(entry => entry.type === "file");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function loadStashMapFromVfs() {
  const files = await listStashFilesFromVfs();
  const map = {};
  for (const file of files) {
    const stash = await chromeStorageVfs.readJson(file.path);
    if (!stash?.title) continue;
    map[stash.title] = {
      info: stash.info,
      expireAt: stash.expireAt,
      createdAt: stash.createdAt,
      updatedAt: stash.updatedAt
    };
  }
  return map;
}

export async function saveStashRecordToVfs({ title, info, expireAt, createdAt, updatedAt } = {}) {
  await migrateLegacyStashesToVfs();
  const now = Date.now();
  const record = {
    title,
    info: String(info ?? ""),
    expireAt: expireAt ?? DEFAULT_STASH_EXPIRE_AT,
    createdAt: Number(createdAt) || Number(updatedAt) || now,
    updatedAt: Number(updatedAt) || now
  };
  await chromeStorageVfs.writeJson(getStashVfsPath(title), record, { expireAt: record.expireAt });
  return record;
}

export async function removeStashRecordFromVfs(title) {
  await migrateLegacyStashesToVfs();
  return chromeStorageVfs.unlink(getStashVfsPath(title));
}

export function watchStashVfs(listener) {
  return chromeStorageVfs.watch(STASH_VFS_DIRECTORY, listener);
}
