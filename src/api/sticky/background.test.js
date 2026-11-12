/* global chrome */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({
  PIN_COMMAND: "pin", loadPrefs: vi.fn().mockResolvedValue({}),
  pinTab: vi.fn(), pinUrl: vi.fn(), reconcileStickies: vi.fn(),
}));
vi.mock("../../utils/chromeStorageVfs", () => ({
  VFS_INDEX_KEY: "vfs:index", VFS_STORAGE_PREFIX: "vfs:file:",
  chromeStorageVfs: { readdir: vi.fn() },
}));
vi.mock("../llm/tools/builtins/evalAndPlayground", () => ({
  SCRIPTS_DIR: "/scripts", _execEvalJs: vi.fn(),
}));

import { chromeStorageVfs } from "../../utils/chromeStorageVfs";
import { _execEvalJs } from "../llm/tools/builtins/evalAndPlayground";
import { registerStickyBackground } from "./background";
import { pinTab, pinUrl } from "./store";

const event = () => ({ addListener: vi.fn() });
const listener = event => event.addListener.mock.calls[0][0];
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const menus = () => globalThis.chrome.contextMenus.create.mock.calls.map(([menu]) => menu);

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.chrome = {
    tabs: { onUpdated: event(), onRemoved: event(), onReplaced: event() },
    runtime: { onStartup: event(), onInstalled: event() },
    commands: { onCommand: event() },
    contextMenus: {
      onClicked: event(), removeAll: vi.fn(callback => callback()),
      create: vi.fn((_menu, callback) => callback()),
    },
    storage: { local: { get: vi.fn().mockResolvedValue({ uiLocale: "en" }) }, onChanged: event() },
    action: { setBadgeText: vi.fn().mockResolvedValue(undefined) },
  };
  chromeStorageVfs.readdir.mockResolvedValue([
    { type: "file", path: "/scripts/demo.js", expireAt: -1 },
    { type: "file", path: "/scripts/nested/other.mjs", expireAt: -1 },
    { type: "file", path: "/scripts/readme.txt", expireAt: -1 },
    { type: "file", path: "/scripts/expired.js", expireAt: 1 },
  ]);
  _execEvalJs.mockResolvedValue({ success: true });
});

describe("background context menus", () => {
  it("builds a nested menu with only runnable, unexpired scripts", async () => {
    registerStickyBackground();
    await flush();
    expect(chromeStorageVfs.readdir).toHaveBeenCalledWith("/scripts", { recursive: true });
    expect(menus()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sticky-pin-page", parentId: "tabpilot-context" }),
      expect.objectContaining({ id: "tabpilot-run-scripts", parentId: "tabpilot-context" }),
      expect.objectContaining({ title: "demo.js", parentId: "tabpilot-run-scripts" }),
      expect.objectContaining({ title: "nested/other.mjs", parentId: "tabpilot-run-scripts" }),
    ]));
    expect(menus().some(menu => /readme|expired/.test(menu.title))).toBe(false);
  });

  it("runs the clicked script on the clicked tab without arguments", async () => {
    registerStickyBackground();
    await flush();
    listener(chrome.contextMenus.onClicked)({ menuItemId: "tabpilot-run-script:/scripts/demo.js" }, { id: 42 });
    await flush();
    expect(_execEvalJs).toHaveBeenCalledWith({ tabId: 42, path: "/scripts/demo.js" });
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 42, text: "✓" });
  });

  it("keeps page and link pinning available", async () => {
    registerStickyBackground();
    await flush();
    const click = listener(chrome.contextMenus.onClicked);
    click({ menuItemId: "sticky-pin-page" }, { id: 42 });
    click({ menuItemId: "sticky-pin-link", linkUrl: "https://example.com" }, { id: 42 });
    await flush();
    expect(pinTab).toHaveBeenCalledWith({ id: 42 }, { laneId: null });
    expect(pinUrl).toHaveBeenCalledWith("https://example.com", { laneId: null });
  });

  it("refreshes scripts and locale on storage changes", async () => {
    registerStickyBackground();
    await flush();
    chromeStorageVfs.readdir.mockResolvedValue([]);
    chrome.storage.local.get.mockResolvedValue({ uiLocale: "zh" });
    listener(chrome.storage.onChanged)({ "vfs:index": {} }, "local");
    await flush();
    expect(menus()).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "运行脚本（空参）" }),
      expect.objectContaining({ title: "暂无可运行的脚本", enabled: false }),
    ]));
  });

  it("handles a missing scripts directory and execution errors", async () => {
    chromeStorageVfs.readdir.mockRejectedValue({ code: "ENOENT" });
    _execEvalJs.mockResolvedValue({ error: "Cannot execute here" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerStickyBackground();
    await flush();
    expect(menus()).toEqual(expect.arrayContaining([expect.objectContaining({ title: "No runnable scripts" })]));
    listener(chrome.contextMenus.onClicked)({ menuItemId: "tabpilot-run-script:/scripts/demo.js" }, { id: 42 });
    await flush();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 42, text: "!" });
    warn.mockRestore();
  });
});
