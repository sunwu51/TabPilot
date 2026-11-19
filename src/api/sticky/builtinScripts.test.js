/* global chrome */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map();
vi.mock("../../utils/chromeStorageVfs", () => ({
  chromeStorageVfs: {
    exists: async path => files.has(path),
    readFile: async path => files.get(path),
    writeFile: async (path, content) => { files.set(path, content); }
  }
}));
vi.mock("../llm/tools/builtins/evalAndPlayground", () => ({ SCRIPTS_DIR: "/scripts" }));

const { BUILTIN_SCRIPTS, ensureBuiltinScripts } = await import("./builtinScripts");
const [pen, tools] = BUILTIN_SCRIPTS;

describe("ensureBuiltinScripts", () => {
  beforeEach(() => {
    files.clear(); // chrome.storage is reset by test/setup.js
  });

  it("ships runnable script bodies", () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(BUILTIN_SCRIPTS.length).toBe(2);
    for (const script of BUILTIN_SCRIPTS) {
      expect(script.path).toMatch(/^\/scripts\/builtin\/.+\.js$/);
      expect(() => new AsyncFunction(script.content)).not.toThrow();
    }
  });

  it("installs missing scripts and is idempotent", async () => {
    expect(await ensureBuiltinScripts()).toEqual([pen.path, tools.path]);
    expect(await ensureBuiltinScripts()).toEqual([]);
  });

  it("upgrades an old untracked built-in, but keeps user edits", async () => {
    files.set(pen.path, "// TabPilot built-in: old version\nreturn 1;");
    files.set(tools.path, "// my own tools");
    expect(await ensureBuiltinScripts()).toEqual([pen.path]);
    expect(files.get(pen.path)).toBe(pen.content);
    expect(files.get(tools.path)).toBe("// my own tools");
  });

  it("upgrades a tracked, unedited script and keeps a tracked, edited one", async () => {
    await ensureBuiltinScripts();
    // Simulate a newer shipped version: the stored copy is the old one we recorded.
    const { builtinScriptHashes } = await chrome.storage.local.get("builtinScriptHashes");
    expect(builtinScriptHashes[pen.path]).toBeTruthy();
    files.set(tools.path, "// edited by me");
    expect(await ensureBuiltinScripts()).toEqual([]);
    expect(files.get(tools.path)).toBe("// edited by me");
  });
});
