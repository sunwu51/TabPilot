/* global chrome */
import { describe, expect, it } from "vitest";
import { chromeStorageVfs } from "./chromeStorageVfs";
import {
  createPlaygroundProject,
  DEFAULT_PLAYGROUND_TTL_MS,
  editPlaygroundFile,
  getPlaygroundFilePath,
  MAX_PLAYGROUND_FILE_BYTES,
  PLAYGROUND_STORAGE_PREFIX,
  readPlaygroundFile,
  removePlaygroundProject,
  requirePlaygroundProject
} from "./playgroundProjects";

describe("playground projects", () => {
  it("stores three virtual files and reads a line range", async () => {
    const beforeCreate = Date.now();
    const project = await createPlaygroundProject({
      html: "<main>Hello</main>",
      css: "body {\n  color: red;\n}\n",
      js: "document.body.dataset.ready = '1';"
    });

    expect(project).toMatchObject({
      revision: 1,
      fileRevisions: {
        "index.html": 1,
        "style.css": 1,
        "script.js": 1
      }
    });
    expect(project.expireAt).toBeGreaterThanOrEqual(beforeCreate + DEFAULT_PLAYGROUND_TTL_MS);
    await expect(chromeStorageVfs.readFile(getPlaygroundFilePath(project.id, "index.html")))
      .resolves.toBe("<main>Hello</main>");
    await expect(readPlaygroundFile({
      playgroundId: project.id,
      file: "style.css",
      startLine: 2,
      endLine: 2
    })).resolves.toMatchObject({
      content: "  color: red;",
      startLine: 2,
      endLine: 2,
      lineCount: 4,
      revision: 1
    });
  });

  it("removes expired playground directories and preserves permanent projects", async () => {
    const now = Date.now();
    const expiring = await createPlaygroundProject({ html: "temporary", expireAt: now + 1000 });
    const permanent = await createPlaygroundProject({ html: "keep", expireAt: -1 });

    await expect(chromeStorageVfs.cleanupExpiredFiles({ now: now + 2000 })).resolves.toMatchObject({
      scanned: 8,
      removed: 4,
      paths: expect.arrayContaining([
        `/playgrounds/${expiring.id}/.project.json`,
        `/playgrounds/${expiring.id}/index.html`,
        `/playgrounds/${expiring.id}/style.css`,
        `/playgrounds/${expiring.id}/script.js`
      ])
    });
    await expect(chromeStorageVfs.exists(`/playgrounds/${expiring.id}`)).resolves.toBe(false);
    await expect(chromeStorageVfs.exists(`/playgrounds/${permanent.id}`)).resolves.toBe(true);
  });

  it("replaces, inserts, and deletes only the requested lines", async () => {
    const project = await createPlaygroundProject({ css: "one\ntwo\nthree" });

    await editPlaygroundFile({ playgroundId: project.id, file: "style.css", startLine: 2, endLine: 2, expectedRevision: 1, content: "TWO" });
    await editPlaygroundFile({ playgroundId: project.id, file: "style.css", startLine: 3, endLine: 2, expectedRevision: 2, content: "inserted" });
    const result = await editPlaygroundFile({ playgroundId: project.id, file: "style.css", startLine: 1, endLine: 1, expectedRevision: 3, content: "" });

    await expect(readPlaygroundFile({ playgroundId: project.id, file: "style.css" })).resolves.toMatchObject({
      content: "TWO\ninserted\nthree",
      lineCount: 3,
      revision: 4
    });
    expect(result).toMatchObject({ revision: 4, lineCount: 3 });
  });

  it("keeps independent revisions for concurrently edited files", async () => {
    const project = await createPlaygroundProject({ css: "old css", js: "old js" });
    const [cssResult, jsResult] = await Promise.all([
      editPlaygroundFile({ playgroundId: project.id, file: "style.css", content: "new css", expectedRevision: 1 }),
      editPlaygroundFile({ playgroundId: project.id, file: "script.js", content: "new js", expectedRevision: 1 })
    ]);

    expect(cssResult.revision).toBe(2);
    expect(jsResult.revision).toBe(2);
    await expect(readPlaygroundFile({ playgroundId: project.id, file: "style.css" })).resolves.toMatchObject({ content: "new css", revision: 2 });
    await expect(readPlaygroundFile({ playgroundId: project.id, file: "script.js" })).resolves.toMatchObject({ content: "new js", revision: 2 });
  });

  it("rejects stale edits and enforces the per-file storage limit", async () => {
    const project = await createPlaygroundProject({ js: "first" });
    await editPlaygroundFile({ playgroundId: project.id, file: "script.js", content: "next\nvalue", expectedRevision: 1 });
    await expect(editPlaygroundFile({
      playgroundId: project.id,
      file: "script.js",
      startLine: 1,
      endLine: 1,
      expectedRevision: 1,
      content: "stale"
    })).rejects.toMatchObject({ code: "ESTALE", currentRevision: 2 });

    const oversized = "x".repeat(MAX_PLAYGROUND_FILE_BYTES + 1);
    await expect(createPlaygroundProject({ html: oversized })).rejects.toMatchObject({ code: "EFBIG" });
  });

  it("migrates legacy storage projects on first access", async () => {
    const projectId = "pg_legacy";
    const legacyKey = `${PLAYGROUND_STORAGE_PREFIX}${projectId}`;
    await chrome.storage.local.set({
      [legacyKey]: {
        id: projectId,
        files: {
          "index.html": "<h1>Legacy</h1>",
          "style.css": "h1 { color: red; }",
          "script.js": ""
        },
        revision: 7,
        createdAt: 10,
        updatedAt: 20
      }
    });

    await expect(requirePlaygroundProject(projectId)).resolves.toMatchObject({
      id: projectId,
      files: { "index.html": "<h1>Legacy</h1>" },
      createdAt: 10,
      updatedAt: 20
    });
    await expect(chrome.storage.local.get(legacyKey)).resolves.toEqual({ [legacyKey]: undefined });
  });

  it("recovers an interrupted migration before deleting legacy data", async () => {
    const projectId = "pg_partial";
    const legacyKey = `${PLAYGROUND_STORAGE_PREFIX}${projectId}`;
    await chrome.storage.local.set({
      [legacyKey]: {
        id: projectId,
        files: {
          "index.html": "complete html",
          "style.css": "complete css",
          "script.js": "complete js"
        }
      }
    });
    await chromeStorageVfs.writeJson(`/playgrounds/${projectId}/.project.json`, { id: projectId });
    await chromeStorageVfs.writeFile(`/playgrounds/${projectId}/index.html`, "partial html");

    await expect(requirePlaygroundProject(projectId)).resolves.toMatchObject({
      files: {
        "index.html": "complete html",
        "style.css": "complete css",
        "script.js": "complete js"
      }
    });
    await expect(chrome.storage.local.get(legacyKey)).resolves.toEqual({ [legacyKey]: undefined });
  });

  it("removes legacy and VFS copies without resurrecting the project", async () => {
    const projectId = "pg_deleted";
    const legacyKey = `${PLAYGROUND_STORAGE_PREFIX}${projectId}`;
    await chrome.storage.local.set({
      [legacyKey]: {
        id: projectId,
        files: { "index.html": "legacy" }
      }
    });

    await removePlaygroundProject(projectId);
    await expect(requirePlaygroundProject(projectId)).rejects.toThrow("Playground project not found");
    await expect(chrome.storage.local.get(legacyKey)).resolves.toEqual({ [legacyKey]: undefined });
  });
});
