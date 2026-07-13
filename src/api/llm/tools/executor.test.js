/* global chrome */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, getBuiltinToolTimeoutSeconds, openHelloWorldPlayground } from "./executor";

vi.mock("../../mcp", () => ({
  callMcpTool: vi.fn(async (url, headers, name, args, timeoutMs) => ({
    url,
    headers,
    name,
    args,
    timeoutMs
  }))
}));

vi.mock("./builtins/downloadHelper", () => ({
  triggerBrowserDownload: vi.fn(async (args) => ({ success: true, ...args, downloadId: 42 })),
  hasDownloadsPermission: vi.fn(async () => true),
  downloadsPermissionRequiredError: () => ({
    error: "downloads permission not granted",
    code: "downloads_permission_required",
    permission: "downloads"
  })
}));

describe("built-in tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a stable error for unknown tools", async () => {
    await expect(executeTool("missing_tool", {})).resolves.toEqual({ error: "Unknown tool: missing_tool" });
  });

  it("routes MCP names to MCP registry tools", async () => {
    const { callMcpTool } = await import("../../mcp");
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
      { type: "http", url: "https://mcp.example/rpc", headers: { Authorization: "Bearer token" } },
      { Authorization: "Bearer token" },
      "lookup",
      { query: "tabs" },
      2000
    );
    expect(result).toMatchObject({ name: "lookup", args: { query: "tabs" } });
  });

  it("routes extension-backed MCP tools with the extension endpoint descriptor", async () => {
    const { callMcpTool } = await import("../../mcp");
    chrome.storage.local.get.mockResolvedValueOnce({ mcpToolTimeoutSeconds: 2 });

    await executeTool("mcp_cookie_helper_get_cookie", { url: "https://example.com", name: "sid" }, [
      {
        name: "get_cookie",
        _toolCallName: "mcp_cookie_helper_get_cookie",
        _serverName: "cookie_helper",
        _serverType: "extension",
        _serverExtensionId: "cookie-helper-id",
        _serverHeaders: {}
      }
    ]);

    expect(callMcpTool).toHaveBeenCalledWith(
      { type: "extension", extensionId: "cookie-helper-id", name: "cookie_helper" },
      {},
      "get_cookie",
      { url: "https://example.com", name: "sid" },
      2000
    );
  });

  it("uses a longer timeout for image tools", () => {
    expect(getBuiltinToolTimeoutSeconds("image_gen")).toBe(600);
    expect(getBuiltinToolTimeoutSeconds("image_edit")).toBe(600);
    expect(getBuiltinToolTimeoutSeconds("tab_list")).toBe(10);
  });

  it("rejects namespaced MCP aliases outside the canonical call-name format", async () => {
    const { callMcpTool } = await import("../../mcp");
    chrome.storage.local.get.mockResolvedValueOnce({ mcpToolTimeoutSeconds: 2 });

    const result = await executeTool("mcp__mcpcenter__tavily_tavily_search", { query: "tabs" }, [
      {
        name: "tavily_tavily-search",
        _serverName: "mcpcenter",
        _toolCallName: "mcp_mcpcenter_tavily_tavily-search",
        _serverUrl: "https://mcp.example/rpc",
        _serverHeaders: { Authorization: "Bearer token" }
      }
    ]);

    expect(result).toMatchObject({ error: "Unknown tool: mcp__mcpcenter__tavily_tavily_search" });
    expect(callMcpTool).not.toHaveBeenCalled();
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

  it("routes Postdog tools through the Postdog manager", async () => {
    chrome.runtime.sendMessage
      .mockImplementationOnce((message, callback) => callback({ success: true, data: [{ id: "req-1" }] }))
      .mockImplementationOnce((message, callback) => callback({ success: true, data: { response: { status: 200 } } }));

    await expect(executeTool("postdog_list_requests", { query: "foo" })).resolves.toEqual({ requests: [{ id: "req-1" }] });
    await expect(executeTool("postdog_run_request", { id: "req-1" })).resolves.toEqual({ result: { response: { status: 200 } } });

    expect(chrome.runtime.sendMessage.mock.calls[0][0]).toEqual({
      type: "postdog_manager",
      action: "list_requests_for_ai",
      payload: { query: "foo" }
    });
    expect(chrome.runtime.sendMessage.mock.calls[1][0]).toEqual({
      type: "postdog_manager",
      action: "run_request",
      payload: { id: "req-1" }
    });
  });

  it("delegates download execution to download helper", async () => {
    const { triggerBrowserDownload } = await import("./builtins/downloadHelper");

    await expect(executeTool("download", { fileName: "a.txt", content: "hello" }))
      .resolves.toMatchObject({ success: true, fileName: "a.txt", content: "hello", downloadId: 42 });
    expect(triggerBrowserDownload).toHaveBeenCalledWith({ fileName: "a.txt", content: "hello", mimeType: undefined });
  });

  it("passes optional mimeType for content downloads", async () => {
    const { triggerBrowserDownload } = await import("./builtins/downloadHelper");

    await expect(executeTool("download", {
      fileName: "report.md",
      content: "# Report",
      mimeType: "text/markdown;charset=utf-8"
    })).resolves.toMatchObject({
      success: true,
      fileName: "report.md",
      content: "# Report",
      mimeType: "text/markdown;charset=utf-8",
      downloadId: 42
    });
    expect(triggerBrowserDownload).toHaveBeenCalledWith({
      fileName: "report.md",
      content: "# Report",
      mimeType: "text/markdown;charset=utf-8"
    });
  });

  it("opens html_playground with encoded query payloads", async () => {
    const result = await executeTool("html_playground", {
      html: "<h1>Hello</h1>",
      css: "h1{color:red}",
      js: "document.body.dataset.ready='1'",
      expanded: true
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringContaining("chrome-extension://test-extension/playground.html?"),
      active: true
    });
    const createdUrl = new URL(chrome.tabs.create.mock.calls.at(-1)[0].url);
    expect(createdUrl.searchParams.get("html")).toBeTruthy();
    expect(createdUrl.searchParams.get("css")).toBeTruthy();
    expect(createdUrl.searchParams.get("js")).toBeTruthy();
    expect(createdUrl.searchParams.get("expanded")).toBe("1");
    expect(result).toMatchObject({ success: true, tabId: 1, expanded: true });
  });

  it("opens hello world playground from settings helper", async () => {
    const result = await openHelloWorldPlayground();

    const createdUrl = new URL(chrome.tabs.create.mock.calls.at(-1)[0].url);
    expect(createdUrl.pathname).toBe("/playground.html");
    expect(createdUrl.searchParams.get("html")).toBeTruthy();
    expect(createdUrl.searchParams.get("expanded")).toBe("1");
    expect(result).toMatchObject({ success: true, tabId: 1, expanded: true });
  });

  it("calls the configured Image API generation endpoint and returns multiple data URLs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { b64_json: "aGVsbG8=", revised_prompt: "A revised prompt" },
        { b64_json: "d29ybGQ=" }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        size: "1024x1024",
        quality: "low"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "generations",
        model: "gpt-image-2",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        imageCount: 2,
        revisedPrompt: "A revised prompt",
        images: [
          { dataUrl: "data:image/png;base64,aGVsbG8=", outputFormat: "png", revisedPrompt: "A revised prompt" },
          { dataUrl: "data:image/png;base64,d29ybGQ=", outputFormat: "png" }
        ]
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer img-token" })
        })
      );
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        model: "gpt-image-2",
        prompt: "Draw a cat",
        size: "1024x1024",
        quality: "low"
      });
      expect(body.b64_json).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses image_model_id to select a configured Image API profile", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { b64_json: "aW1n" }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        activeImageModelId: "img_default",
        imageModels: [
          {
            id: "img_default",
            name: "Default image",
            imageBaseUrl: "https://default.example/v1",
            imageApiKey: "default-token",
            imageApiProtocol: "generate",
            imageModel: "default-image-model"
          },
          {
            id: "img_alt01",
            name: "Alt image",
            imageBaseUrl: "https://alt.example/v1",
            imageApiKey: "alt-token",
            imageApiProtocol: "generate",
            imageModel: "alt-image-model"
          }
        ]
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        image_model_id: "img_alt01"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "generations",
        model: "alt-image-model",
        imageModelId: "img_alt01",
        imageModelName: "alt-image-model",
        dataUrl: "data:image/png;base64,aW1n"
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://alt.example/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer alt-token" })
        })
      );
      expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).model).toBe("alt-image-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("calls the configured chat/completions image endpoint and reads OpenRouter-style images", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "Generated",
            images: [
              { image_url: { url: "data:image/png;base64,aGVsbG8=" } }
            ]
          }
        }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://openrouter.ai/api/v1",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "google/gemini-2.5-flash-image-preview"
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        size: "1024x1024"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "chat_completions",
        model: "google/gemini-2.5-flash-image-preview",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        imageCount: 1
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer img-token"
          })
        })
      );
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        model: "google/gemini-2.5-flash-image-preview",
        modalities: ["image", "text"],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Draw a cat" }
            ]
          }
        ],
        size: "1024x1024"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores free-form image model overrides from tool args", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "configured-image-model"
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        model: "made-up-model"
      });

      expect(result).toMatchObject({
        success: true,
        model: "configured-image-model"
      });
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.model).toBe("configured-image-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("calls the configured Image API edit endpoint with multipart image and mask", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1/images/generations",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        image: "data:image/png;base64,aGVsbG8=",
        mask: "data:image/png;base64,aGVsbG8=",
        output_format: "webp"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "edits",
        dataUrl: "data:image/webp;base64,aGVsbG8=",
        inputImageCount: 1,
        maskApplied: true
      });
      expect(globalThis.fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
      const init = globalThis.fetch.mock.calls[0][1];
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Bearer img-token" });
      const entries = Array.from(init.body.entries());
      expect(entries.find(([key]) => key === "prompt")?.[1]).toBe("Add a hat");
      expect(entries.find(([key]) => key === "model")?.[1]).toBe("gpt-image-2");
      expect(entries.find(([key]) => key === "output_format")?.[1]).toBe("webp");
      expect(entries.find(([key]) => key === "image[]")?.[1]).toBeInstanceOf(File);
      expect(entries.find(([key]) => key === "mask")?.[1]).toBeInstanceOf(File);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts ordered image arrays for Image API edits", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Use the second image as a style reference",
        images: [
          "data:image/png;base64,aGVsbG8=",
          "data:image/png;base64,d29ybGQ="
        ]
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "edits",
        inputImageCount: 2
      });
      const entries = Array.from(globalThis.fetch.mock.calls[0][1].body.entries());
      expect(entries.filter(([key]) => key === "image[]")).toHaveLength(2);
      expect(entries.find(([key]) => key === "mask")).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends edit images through chat/completions image_url content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            images: [
              { type: "image_url", image_url: { url: "https://example.com/generated.png" } }
            ]
          }
        }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "google/gemini-2.5-flash-image-preview"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        images: [
          "data:image/png;base64,aGVsbG8=",
          "https://example.com/ref.png"
        ]
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "chat_completions",
        inputImageCount: 2,
        imageUrl: "https://example.com/generated.png"
      });
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "Add a hat" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        { type: "image_url", image_url: { url: "https://example.com/ref.png" } }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports mask as unsupported for chat/completions image edits", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://openrouter.ai/api/v1",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "google/gemini-2.5-flash-image-preview"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        image: "data:image/png;base64,aGVsbG8=",
        mask: "data:image/png;base64,aGVsbG8="
      });

      expect(result).toEqual({
        error: "mask is not supported by the chat/completions image protocol"
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unresolved local image refs before calling the Image API", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        image: "data:image/png;base64,aGVsbG8=",
        mask: "\"|deRef:img_2|\""
      });

      expect(result).toMatchObject({
        error: "mask ref img_2 was not resolved before image tool execution"
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
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
