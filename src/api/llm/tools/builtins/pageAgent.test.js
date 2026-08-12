import { describe, expect, it } from "vitest";
import { _execPageAgent, initializePageAgent } from "./pageAgent";

describe("Page Agent runtime injection", () => {
  it("injects the packaged runtime and shows its panel in the current active tab", async () => {
    chrome.windows.getCurrent.mockResolvedValue({ id: 1 });
    chrome.tabs.query.mockResolvedValue([{ id: 7, url: "https://example.com/", windowId: 1 }]);
    chrome.tabs.get.mockResolvedValue({ id: 7, url: "https://example.com/", windowId: 1 });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: { panelVisible: true } }]);
    chrome.storage.local.get.mockResolvedValue({
      llmConfig: {
        activeLlmModelId: "model-1",
        llmModels: [{ id: "model-1", apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", model: "test-model" }]
      }
    });

    const result = await initializePageAgent();

    expect(result).toEqual({ success: true, tabId: 7, url: "https://example.com/", panelVisible: true });
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 7 },
      world: "MAIN",
      files: ["vendor/page-agent.demo.js"]
    });
  });

  it("injects the packaged runtime in the main world instead of creating a CDN script tag", async () => {
    chrome.tabs.get.mockResolvedValue({ id: 7, url: "https://example.com/", windowId: 1 });
    chrome.storage.local.get.mockResolvedValue({
      llmConfig: {
        activeLlmModelId: "model-1",
        llmModels: [{ id: "model-1", apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", model: "test-model" }]
      }
    });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: { success: true, data: "done", status: "completed" } }]);

    const result = await _execPageAgent({ tabId: 7, instruction: "Complete the task" });

    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(1, expect.objectContaining({
      target: { tabId: 7 },
      world: "MAIN"
    }));
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 7 },
      world: "MAIN",
      files: ["vendor/page-agent.demo.js"]
    });
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(3, expect.objectContaining({
      target: { tabId: 7 },
      world: "MAIN"
    }));
    expect(result).toMatchObject({ tabId: 7, success: true, data: "done" });
  });

  it("preserves the default /v1 prefix when the configured URL is only an origin", async () => {
    chrome.tabs.get.mockResolvedValue({ id: 7, url: "https://example.com/", windowId: 1 });
    chrome.storage.local.get.mockResolvedValue({
      llmConfig: {
        activeLlmModelId: "model-1",
        llmModels: [{ id: "model-1", apiType: "openai-chat-completions", baseUrl: "https://api.example.com", model: "test-model" }]
      }
    });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: { success: true, data: "done", status: "completed" } }]);

    await _execPageAgent({ tabId: 7, instruction: "Complete the task" });

    const executeArgs = chrome.scripting.executeScript.mock.calls[1][0].args[0];
    expect(executeArgs.config.baseURL).toBe("https://api.example.com/v1");
  });
});
