/* global chrome */
import { DEFAULT_STASH_EXPIRE_AT, STASH_STORAGE_KEY } from "../../core/constants";

async function _getStashes() {
  const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
  return result[STASH_STORAGE_KEY] || {};
}

async function _saveStashes(stashes) {
  await chrome.storage.local.set({ [STASH_STORAGE_KEY]: stashes });
}

/**
 * Stash info to browser local storage with optional expiration.
 */
export async function _execStashInBrowser({ title, info, expireAt }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };
  if (info === undefined || info === null) return { error: "info is required" };

  const stashes = await _getStashes();
  const now = Date.now();
  let computedExpireAt;
  if (expireAt === -1) {
    computedExpireAt = -1;
  } else if (typeof expireAt === "number" && expireAt > now) {
    computedExpireAt = expireAt;
  } else {
    computedExpireAt = DEFAULT_STASH_EXPIRE_AT;
  }

  const existing = stashes[title];
  stashes[title] = {
    info: String(info),
    expireAt: computedExpireAt,
    createdAt: Number(existing?.createdAt) || Number(existing?.updatedAt) || now,
    updatedAt: now
  };

  await _saveStashes(stashes);

  return {
    success: true,
    title,
    expireAt: computedExpireAt,
    permanent: computedExpireAt === -1
  };
}

/**
 * Get a single stash by title. Filters out expired stashes.
 */
export async function _execUnstashInBrowser({ title }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };

  const stashes = await _getStashes();
  const stash = stashes[title];
  if (!stash) return { error: `Stash not found: ${title}` };

  const now = Date.now();
  if (stash.expireAt !== -1 && now > stash.expireAt) {
    delete stashes[title];
    await _saveStashes(stashes);
    return { error: `Stash has expired: ${title}` };
  }

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
 * List all stash titles, excluding expired ones.
 */
export async function _execListStashesInBrowser() {
  const stashes = await _getStashes();
  const now = Date.now();
  const titles = [];
  let cleaned = false;

  for (const [title, stash] of Object.entries(stashes)) {
    if (stash.expireAt !== -1 && now > stash.expireAt) {
      delete stashes[title];
      cleaned = true;
    } else {
      titles.push(title);
    }
  }

  if (cleaned) await _saveStashes(stashes);

  return {
    success: true,
    count: titles.length,
    titles
  };
}

/**
 * Remove a stash by title.
 */
export async function _execRemoveStashInBrowser({ title }) {
  if (!title || typeof title !== "string") return { error: "title is required and must be a string" };

  const stashes = await _getStashes();
  if (!stashes[title]) {
    return { success: true, title, existed: false };
  }

  delete stashes[title];
  await _saveStashes(stashes);

  return { success: true, title, removed: true };
}
