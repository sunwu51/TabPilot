import { DEFAULT_STASH_EXPIRE_AT } from "../../core/constants";
import { chromeStorageVfs } from "../../../../utils/chromeStorageVfs";
import {
  getStashVfsPath,
  listStashFilesFromVfs,
  readStashRecordFromVfs,
  removeStashRecordFromVfs,
  saveStashRecordToVfs
} from "../../../../utils/stashVfs";

function toUnstashResult(title, stash) {
  return {
    success: true,
    title,
    info: stash.info,
    expireAt: stash.expireAt,
    createdAt: stash.createdAt,
    updatedAt: stash.updatedAt
  };
}

/**
 * Stash info to the shared browser VFS with optional expiration.
 */
export async function _execStashInBrowser({ title, info, expireAt }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };
  if (info === undefined || info === null) return { error: "info is required" };

  const existingRecord = await readStashRecordFromVfs(title);
  const existing = existingRecord?.stash;
  const now = Date.now();
  let computedExpireAt;
  if (expireAt === -1) {
    computedExpireAt = -1;
  } else if (typeof expireAt === "number" && expireAt > now) {
    computedExpireAt = expireAt;
  } else {
    computedExpireAt = DEFAULT_STASH_EXPIRE_AT;
  }

  await saveStashRecordToVfs({
    title,
    info: String(info),
    expireAt: computedExpireAt,
    createdAt: Number(existing?.createdAt) || Number(existing?.updatedAt) || now,
    updatedAt: now
  });

  return {
    success: true,
    title,
    expireAt: computedExpireAt,
    permanent: computedExpireAt === -1
  };
}

/**
 * Get a single stash by title. Removes expired stash files.
 */
export async function _execUnstashInBrowser({ title }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };

  let record = await readStashRecordFromVfs(title);
  if (!record) return { error: `Stash not found: ${title}` };

  const now = Date.now();
  if (record.stash.expireAt !== -1 && now > record.stash.expireAt) {
    try {
      await chromeStorageVfs.unlink(record.path, { expectedRevision: record.revision });
    } catch (error) {
      if (error?.code !== "ESTALE") throw error;
      record = await readStashRecordFromVfs(title);
      if (record && (record.stash.expireAt === -1 || now <= record.stash.expireAt)) {
        return toUnstashResult(title, record.stash);
      }
    }
    return { error: `Stash has expired: ${title}` };
  }

  return toUnstashResult(title, record.stash);
}

/**
 * List all stash titles, excluding and removing expired files.
 */
export async function _execListStashesInBrowser() {
  const files = await listStashFilesFromVfs();
  const now = Date.now();
  const titles = new Set();

  for (const file of files) {
    const record = await chromeStorageVfs.readJsonWithStat(file.path);
    const stash = record.value;
    if (stash.expireAt !== -1 && now > stash.expireAt) {
      try {
        await chromeStorageVfs.unlink(file.path, { expectedRevision: record.stat.revision });
      } catch (error) {
        if (error?.code !== "ESTALE") throw error;
        const latest = await chromeStorageVfs.readJson(file.path);
        if (latest.expireAt === -1 || now <= latest.expireAt) titles.add(latest.title);
      }
    } else {
      titles.add(stash.title);
    }
  }

  const sortedTitles = [...titles].sort((a, b) => a.localeCompare(b));
  return {
    success: true,
    count: sortedTitles.length,
    titles: sortedTitles
  };
}

/**
 * Remove a stash file by title.
 */
export async function _execRemoveStashInBrowser({ title }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };

  const result = await removeStashRecordFromVfs(title);
  if (!result.removed) return { success: true, title, existed: false };
  return { success: true, title, removed: true, path: getStashVfsPath(title) };
}
