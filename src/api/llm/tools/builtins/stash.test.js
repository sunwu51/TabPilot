/* global chrome */
import { describe, expect, it, vi } from "vitest";
import { STASH_STORAGE_KEY } from "../../core/constants";
import { chromeStorageVfs } from "../../../../utils/chromeStorageVfs";
import {
  _execListStashesInBrowser,
  _execRemoveStashInBrowser,
  _execStashInBrowser,
  _execUnstashInBrowser
} from "./stash";

describe("VFS-backed stashes", () => {
  it("creates, updates, lists, reads, and removes stash files", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    await expect(_execStashInBrowser({ title: "preference", info: "compact", expireAt: -1 }))
      .resolves.toMatchObject({ success: true, permanent: true });
    now.mockReturnValue(200);
    await expect(_execStashInBrowser({ title: "preference", info: "detailed", expireAt: -1 }))
      .resolves.toMatchObject({ success: true });

    await expect(_execListStashesInBrowser()).resolves.toEqual({ success: true, count: 1, titles: ["preference"] });
    await expect(_execUnstashInBrowser({ title: "preference" })).resolves.toMatchObject({
      success: true,
      info: "detailed",
      createdAt: 100,
      updatedAt: 200
    });
    await expect(_execRemoveStashInBrowser({ title: "preference" })).resolves.toMatchObject({ removed: true });
    await expect(_execRemoveStashInBrowser({ title: "preference" })).resolves.toMatchObject({ existed: false });
  });

  it("removes expired stash files while listing", async () => {
    const now = Date.now();
    await _execStashInBrowser({ title: "temporary", info: "soon", expireAt: now + 1000 });
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);

    await expect(_execListStashesInBrowser()).resolves.toEqual({ success: true, count: 0, titles: [] });
    await expect(_execUnstashInBrowser({ title: "temporary" })).resolves.toMatchObject({ error: "Stash not found: temporary" });
  });

  it("stores stash expiration in VFS metadata for periodic cleanup", async () => {
    const now = Date.now();
    await _execStashInBrowser({ title: "alarm-cleanup", info: "temporary", expireAt: now + 1000 });

    const entries = await chromeStorageVfs.readdir("/stashes");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ expireAt: now + 1000 });
    await expect(chromeStorageVfs.cleanupExpiredFiles({ now: now + 2000 }))
      .resolves.toMatchObject({ removed: 1, paths: [entries[0].path] });
    await expect(_execUnstashInBrowser({ title: "alarm-cleanup" }))
      .resolves.toMatchObject({ error: "Stash not found: alarm-cleanup" });
  });

  it("migrates legacy stash objects into individual VFS files", async () => {
    await chrome.storage.local.set({
      [STASH_STORAGE_KEY]: {
        "偏好/输出": {
          info: "简洁",
          expireAt: -1,
          createdAt: 10,
          updatedAt: 20
        }
      }
    });

    await expect(_execUnstashInBrowser({ title: "偏好/输出" })).resolves.toMatchObject({
      success: true,
      info: "简洁",
      createdAt: 10,
      updatedAt: 20
    });
    await expect(chrome.storage.local.get(STASH_STORAGE_KEY)).resolves.toEqual({ [STASH_STORAGE_KEY]: undefined });
    const entries = await chromeStorageVfs.readdir("/stashes");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "file" });
  });
});
