import { describe, expect, it, vi } from "vitest";
import { _execEvalJs } from "./evalAndPlayground";
import { chromeStorageVfs as vfs } from "../../../../utils/chromeStorageVfs";

describe("eval_js", () => {
  it("injects the packaged Sval runtime into the main world before running code", async () => {
    chrome.windows.getCurrent.mockResolvedValue({ id: 1 });
    chrome.tabs.query.mockResolvedValue([{ id: 9, url: "https://example.com/", windowId: 1 }]);
    chrome.tabs.get.mockResolvedValue({ id: 9, url: "https://example.com/", windowId: 1, groupId: -1 });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: { success: true, strategy: "sval", result: 42 } }]);

    const result = await _execEvalJs({ jsScript: "return 42;" });

    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(1, expect.objectContaining({
      target: { tabId: 9 },
      world: "MAIN"
    }));
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 9 },
      world: "MAIN",
      files: ["vendor/sval.min.js"]
    });
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(3, expect.objectContaining({
      target: { tabId: 9 },
      world: "MAIN",
      args: ["return 42;"]
    }));
    expect(result).toMatchObject({ world: "MAIN", strategy: "sval", result: 42 });
  });

  it("does not inject Sval again when it is already present", async () => {
    chrome.windows.getCurrent.mockResolvedValue({ id: 1 });
    chrome.tabs.query.mockResolvedValue([{ id: 9, url: "https://example.com/", windowId: 1 }]);
    chrome.tabs.get.mockResolvedValue({ id: 9, url: "https://example.com/", windowId: 1, groupId: -1 });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: { success: true, strategy: "sval", result: "ok" } }]);

    await _execEvalJs({ jsScript: "return 'ok';" });

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalledWith(expect.objectContaining({ files: ["vendor/sval.min.js"] }));
  });
});

describe("eval_js saved scripts", () => {
  function mockTab() {
    chrome.tabs.get.mockResolvedValue({ id: 9, url: "https://example.com/", windowId: 1, groupId: -1 });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: { success: true, strategy: "sval", result: 3 } }]);
  }

  it("runs a script saved in the VFS and passes args as JSON", async () => {
    await vfs.writeFile("/scripts/count-rows.js", "return document.querySelectorAll(args.selector).length;");
    mockTab();

    const result = await _execEvalJs({ tabId: 9, path: "scripts/count-rows.js", args: { selector: "tr" } });

    expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 9 },
      args: ["return document.querySelectorAll(args.selector).length;", '{"selector":"tr"}']
    }));
    expect(result).toMatchObject({ path: "/scripts/count-rows.js", tabId: 9, result: 3 });
  });

  it("reports a missing script without touching the page", async () => {
    const result = await _execEvalJs({ tabId: 9, path: "/scripts/nope.js" });
    expect(result.error).toMatch(/Cannot read script/);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("requires either inline code or a path", async () => {
    expect((await _execEvalJs({ tabId: 9 })).error).toMatch(/jsScript, or path/);
  });
});
