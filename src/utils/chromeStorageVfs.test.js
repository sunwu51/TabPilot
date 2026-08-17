/* global chrome */
import { describe, expect, it, vi } from "vitest";
import {
  createChromeStorageVfs,
  normalizeVfsPath,
  VFS_INDEX_KEY,
  VFS_STORAGE_PREFIX
} from "./chromeStorageVfs";

describe("ChromeStorageVfs", () => {
  it("normalizes paths and provides file and directory metadata", async () => {
    const fs = createChromeStorageVfs();
    expect(normalizeVfsPath("projects\\demo/./src/../index.html")).toBe("/projects/demo/index.html");
    expect(() => normalizeVfsPath("../../outside")).toThrow("escapes VFS root");

    const written = await fs.writeFile("/projects/demo/index.html", "hello");
    expect(written).toMatchObject({ type: "file", size: 5, lineCount: 1, revision: 1 });
    await expect(fs.readFile("/projects/demo/index.html")).resolves.toBe("hello");
    await expect(fs.stat("/projects/demo")).resolves.toMatchObject({ type: "directory" });
    await expect(fs.exists("/missing")).resolves.toBe(false);
    await expect(fs.readdir("/projects")).resolves.toEqual([
      expect.objectContaining({ type: "directory", name: "demo", path: "/projects/demo" })
    ]);
    await expect(fs.readdir("/projects/demo")).resolves.toEqual([
      expect.objectContaining({ type: "file", name: "index.html", revision: 1 })
    ]);
  });

  it("supports line reads, patches, insertion, deletion, and stale-write protection", async () => {
    const fs = createChromeStorageVfs();
    await fs.writeFile("/code/style.css", "one\ntwo\nthree");
    await expect(fs.readLines("/code/style.css", { startLine: 2, endLine: 2 })).resolves.toMatchObject({
      content: "two",
      lineCount: 3,
      revision: 1
    });

    await fs.applyPatch("/code/style.css", { startLine: 2, endLine: 2, content: "TWO", expectedRevision: 1 });
    await fs.applyPatch("/code/style.css", { startLine: 3, endLine: 2, content: "inserted", expectedRevision: 2 });
    const result = await fs.applyPatch("/code/style.css", { startLine: 1, endLine: 1, content: "", expectedRevision: 3 });
    expect(result).toMatchObject({ revision: 4, lineCount: 3 });
    await expect(fs.readFile("/code/style.css")).resolves.toBe("TWO\ninserted\nthree");
    await expect(fs.writeFile("/code/style.css", "stale", { expectedRevision: 1 })).rejects.toMatchObject({
      code: "ESTALE",
      currentRevision: 4
    });
  });

  it("atomically replaces a multi-line range and updates total line count", async () => {
    const fs = createChromeStorageVfs();
    await fs.writeFile("/code/app.js", "one\ntwo\nthree");

    await expect(fs.editRange("/code/app.js", {
      expectedRevision: 1,
      startLine: 2,
      endLine: 3,
      originalContent: "two\nthree",
      newContent: "TWO\ninserted\nTHREE"
    })).resolves.toMatchObject({ revision: 2, startLine: 2, endLine: 3, lineCount: 4 });
    await expect(fs.readFile("/code/app.js")).resolves.toBe("one\nTWO\ninserted\nTHREE");
    await expect(fs.stat("/code/app.js")).resolves.toMatchObject({ lineCount: 4 });

    await expect(fs.editRange("/code/app.js", {
      expectedRevision: 2,
      startLine: 1,
      endLine: 2,
      originalContent: "one\nstale",
      newContent: "changed"
    })).rejects.toMatchObject({ code: "ECONFLICT", startLine: 1, endLine: 2, actualContent: "one\nTWO" });
    await expect(fs.readFile("/code/app.js")).resolves.toBe("one\nTWO\ninserted\nTHREE");
  });

  it("renames and recursively removes files and directories", async () => {
    const fs = createChromeStorageVfs();
    await fs.writeJson("/stash/a.json", { value: 1 });
    await fs.writeFile("/stash/nested/b.txt", "b");

    await expect(fs.readJson("/stash/a.json")).resolves.toEqual({ value: 1 });
    await expect(fs.rename("/stash", "/archive")).resolves.toMatchObject({ moved: 2 });
    await expect(fs.exists("/stash/a.json")).resolves.toBe(false);
    await expect(fs.readFile("/archive/nested/b.txt")).resolves.toBe("b");
    await expect(fs.unlink("/archive")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await expect(fs.unlink("/archive", { recursive: true })).resolves.toMatchObject({ removed: 2 });
  });

  it("rejects file-directory collisions and unsafe renames", async () => {
    const fs = createChromeStorageVfs();
    await fs.writeFile("/tree/child.txt", "child");
    await expect(fs.writeFile("/tree", "file")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(fs.writeFile("/tree/child.txt/nested", "file")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(fs.readdir("/tree/child.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(fs.rename("/tree", "/tree/nested")).rejects.toMatchObject({ code: "EINVAL" });

    await fs.writeFile("/source/a.txt", "source");
    await fs.writeFile("/destination/old.txt", "old");
    await expect(fs.rename("/source", "/destination", { overwrite: true })).resolves.toMatchObject({ replaced: 1 });
    await expect(fs.exists("/destination/old.txt")).resolves.toBe(false);
    await expect(fs.readFile("/destination/a.txt")).resolves.toBe("source");
  });

  it("conditionally deletes only the revision that was inspected", async () => {
    const fs = createChromeStorageVfs();
    await fs.writeFile("/temporary.txt", "old");
    await fs.writeFile("/temporary.txt", "new");
    await expect(fs.unlink("/temporary.txt", { expectedRevision: 1 })).rejects.toMatchObject({
      code: "ESTALE",
      currentRevision: 2
    });
    await expect(fs.readFile("/temporary.txt")).resolves.toBe("new");
  });

  it("periodically removes expired files and preserves permanent files", async () => {
    const fs = createChromeStorageVfs();
    await fs.writeFile("/temporary.txt", "temporary", { expireAt: 100 });
    await fs.writeFile("/permanent.txt", "permanent");

    await expect(fs.cleanupExpiredFiles({ now: 101 })).resolves.toEqual({
      scanned: 2,
      removed: 1,
      paths: ["/temporary.txt"]
    });
    await expect(fs.exists("/temporary.txt")).resolves.toBe(false);
    await expect(fs.stat("/permanent.txt")).resolves.toMatchObject({ expireAt: -1 });
  });

  it("uses the metadata index after a one-time legacy rebuild", async () => {
    const fs = createChromeStorageVfs();
    const legacyRecord = {
      type: "file",
      path: "/legacy/file.txt",
      content: "legacy",
      size: 6,
      revision: 2,
      createdAt: 1,
      updatedAt: 2
    };
    await chrome.storage.local.set({
      [`${VFS_STORAGE_PREFIX}${encodeURIComponent(legacyRecord.path)}`]: legacyRecord
    });

    await expect(fs.readdir("/legacy")).resolves.toEqual([
      expect.objectContaining({ name: "file.txt", revision: 2 })
    ]);
    const storedIndex = await chrome.storage.local.get(VFS_INDEX_KEY);
    expect(storedIndex[VFS_INDEX_KEY].entries[legacyRecord.path]).toMatchObject({
      size: 6,
      lineCount: 1,
      revision: 2
    });
    expect(storedIndex[VFS_INDEX_KEY].entries[legacyRecord.path]).not.toHaveProperty("content");

    chrome.storage.local.get.mockClear();
    await fs.stat("/legacy");
    await fs.writeFile("/legacy/next.txt", "next");
    await fs.rename("/legacy/next.txt", "/legacy/renamed.txt");
    await fs.unlink("/legacy/renamed.txt");
    expect(chrome.storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(false);
  });

  it("notifies watchers for matching file changes", async () => {
    const fs = createChromeStorageVfs();
    const listener = vi.fn();
    const stop = fs.watch("/projects/demo", listener);
    const onChanged = chrome.storage.onChanged.addListener.mock.calls.at(-1)[0];
    const record = {
      type: "file",
      path: "/projects/demo/index.html",
      content: "hello",
      size: 5,
      revision: 1,
      createdAt: 1,
      updatedAt: 1
    };
    onChanged({
      [`${VFS_STORAGE_PREFIX}${encodeURIComponent(record.path)}`]: { newValue: record }
    }, "local");

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: "create",
      path: "/projects/demo/index.html",
      stat: expect.objectContaining({ revision: 1 })
    }));
    stop();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(onChanged);
  });
});
