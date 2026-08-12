import { describe, expect, it, vi } from "vitest";
import { _execEvalJs } from "./evalAndPlayground";

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
