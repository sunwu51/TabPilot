import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./builtins";

vi.mock("../mcp", () => ({
  callMcpTool: vi.fn(async (url, headers, name, args, timeoutMs) => ({
    url,
    headers,
    name,
    args,
    timeoutMs
  }))
}));

vi.mock("./downloadHelper", () => ({
  triggerBrowserDownload: vi.fn(async (args) => ({ success: true, ...args, downloadId: 42 }))
}));

describe("built-in tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a stable error for unknown tools", async () => {
    await expect(executeTool("missing_tool", {})).resolves.toEqual({ error: "Unknown tool: missing_tool" });
  });

  it("routes MCP names to MCP registry tools", async () => {
    const { callMcpTool } = await import("../mcp");
    chrome.storage.local.get.mockResolvedValueOnce({ mcpToolTimeoutSeconds: 2 });

    const result = await executeTool("mcp_docs_lookup", { query: "tabs" }, [
      {
        name: "lookup",
        _toolCallName: "mcp_docs_lookup",
        _serverUrl: "https://mcp.example/rpc",
        _serverHeaders: { Authorization: "Bearer token" }
      }
    ]);

    expect(callMcpTool).toHaveBeenCalledWith(
      "https://mcp.example/rpc",
      { Authorization: "Bearer token" },
      "lookup",
      { query: "tabs" },
      2000
    );
    expect(result).toMatchObject({ name: "lookup", args: { query: "tabs" } });
  });

  it("routes run_macro with flat arguments to the macro manager", async () => {
    chrome.runtime.sendMessage.mockImplementationOnce((message, callback) => {
      callback({ success: true, tabId: 9, report: { ok: true } });
    });

    const result = await executeTool("run_macro", {
      id: "macro-1",
      inputValues: { input_1: "hello" },
      speed: "fast",
      stepDelayMs: "25"
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "macro_manager",
      action: "replay",
      payload: {
        id: "macro-1",
        inputValues: { input_1: "hello" },
        options: { speed: "fast", stepDelayMs: 25 }
      }
    }, expect.any(Function));
    expect(result).toEqual({ tabId: 9, report: { ok: true } });
  });

  it("validates run_macro id", async () => {
    await expect(executeTool("run_macro", {})).resolves.toEqual({ error: "id is required" });
  });

  it("routes list_macros and describe_macro through macro manager", async () => {
    chrome.runtime.sendMessage
      .mockImplementationOnce((message, callback) => callback({ success: true, data: [{ id: "a" }] }))
      .mockImplementationOnce((message, callback) => callback({ success: true, data: { id: "a" } }));

    await expect(executeTool("list_macros", { query: "foo" })).resolves.toEqual({ macros: [{ id: "a" }] });
    await expect(executeTool("describe_macro", { id: "a" })).resolves.toEqual({ macro: { id: "a" } });

    expect(chrome.runtime.sendMessage.mock.calls[0][0]).toEqual({
      type: "macro_manager",
      action: "list_for_ai",
      payload: { query: "foo" }
    });
    expect(chrome.runtime.sendMessage.mock.calls[1][0]).toEqual({
      type: "macro_manager",
      action: "describe_for_ai",
      payload: { id: "a" }
    });
  });

  it("delegates download execution to download helper", async () => {
    const { triggerBrowserDownload } = await import("./downloadHelper");

    await expect(executeTool("download", { fileName: "a.txt", content: "hello" }))
      .resolves.toMatchObject({ success: true, fileName: "a.txt", content: "hello", downloadId: 42 });
    expect(triggerBrowserDownload).toHaveBeenCalledWith({ fileName: "a.txt", content: "hello" });
  });

  it("serializes recent downloads", async () => {
    chrome.downloads.search.mockResolvedValueOnce([
      { id: 1, url: "https://example.com/a", filename: "C:\\Downloads\\a.txt", state: "complete", totalBytes: 3 }
    ]);

    await expect(executeTool("download_list", { limit: 1 })).resolves.toEqual({
      count: 1,
      downloads: [expect.objectContaining({
        id: 1,
        filename: "C:\\Downloads\\a.txt",
        state: "complete",
        totalBytes: 3
      })]
    });
    expect(chrome.downloads.search).toHaveBeenCalledWith({ limit: 1, orderBy: ["-startTime"] });
  });

  it("builds download search filters", async () => {
    chrome.downloads.search.mockResolvedValueOnce([]);

    const result = await executeTool("download_search", {
      query: "foo bar",
      state: "complete",
      startedAfter: 1000,
      startedBefore: 2000,
      limit: 2
    });

    expect(result.query).toMatchObject({
      query: ["foo", "bar"],
      state: "complete",
      startedAfter: new Date(1000).toISOString(),
      startedBefore: new Date(2000).toISOString(),
      limit: 2
    });
  });

  it("validates sleep duration without waiting", async () => {
    vi.useFakeTimers();
    const promise = executeTool("sleep", { seconds: 1 });
    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toMatchObject({ success: true, requestedSeconds: 1 });
    await expect(executeTool("sleep", { seconds: 0 })).resolves.toEqual({
      error: "seconds must be an integer between 1 and 300 (inclusive)"
    });
  });
});

