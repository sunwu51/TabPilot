import { beforeEach, describe, expect, it, vi } from "vitest";

const jsonHeaders = { "content-type": "application/json" };

function mockJsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ ...jsonHeaders, ...headers }),
    json: vi.fn(async () => body),
    text: vi.fn(async () => typeof body === "string" ? body : JSON.stringify(body))
  };
}

describe("MCP Streamable HTTP session handling", () => {
  beforeEach(async () => {
    vi.resetModules();
    globalThis.fetch = vi.fn();
  });

  it("stores Mcp-Session-Id from initialize and sends it on later requests", async () => {
    const { connectMcpServer, callMcpTool } = await import("./index");

    fetch
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "session-a" }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "ok" }] }
      }));

    await expect(connectMcpServer("https://mcp.example/rpc", { Authorization: "Bearer token" }))
      .resolves.toMatchObject({ name: "Docs", tools: [{ name: "lookup" }] });
    await expect(callMcpTool("https://mcp.example/rpc", { Authorization: "Bearer token" }, "lookup", { q: "tabs" }))
      .resolves.toEqual({ result: "ok" });

    expect(fetch.mock.calls[0][1].headers["Mcp-Session-Id"]).toBeUndefined();
    expect(fetch.mock.calls[1][1].headers["Mcp-Session-Id"]).toBe("session-a");
    expect(fetch.mock.calls[2][1].headers["Mcp-Session-Id"]).toBe("session-a");
  });

  it("re-initializes without sending the previously stored session id", async () => {
    const { connectMcpServer } = await import("./index");

    fetch
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "session-a" }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "session-b" }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 4,
        result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
      }));

    await expect(connectMcpServer("https://mcp.example/rpc", {}))
      .resolves.toMatchObject({ name: "Docs", tools: [{ name: "lookup" }] });
    await expect(connectMcpServer("https://mcp.example/rpc", {}))
      .resolves.toMatchObject({ name: "Docs", tools: [{ name: "lookup" }] });

    expect(JSON.parse(fetch.mock.calls[2][1].body).method).toBe("initialize");
    expect(fetch.mock.calls[2][1].headers["Mcp-Session-Id"]).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[3][1].body).method).toBe("tools/list");
    expect(fetch.mock.calls[3][1].headers["Mcp-Session-Id"]).toBe("session-b");
  });

  it("refreshes the session after a 404 with an existing session and retries once", async () => {
    const { connectMcpServer, callMcpTool } = await import("./index");

    fetch
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "old-session" }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
      }))
      .mockResolvedValueOnce(mockJsonResponse("expired", { status: 404 }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 4,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "new-session" }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 5,
        result: { content: [{ type: "text", text: "fresh" }] }
      }));

    await connectMcpServer("https://mcp.example/rpc", {});
    await expect(callMcpTool("https://mcp.example/rpc", {}, "lookup", { q: "tabs" }))
      .resolves.toEqual({ result: "fresh" });

    expect(fetch.mock.calls[2][1].headers["Mcp-Session-Id"]).toBe("old-session");
    expect(JSON.parse(fetch.mock.calls[3][1].body).method).toBe("initialize");
    expect(fetch.mock.calls[3][1].headers["Mcp-Session-Id"]).toBeUndefined();
    expect(fetch.mock.calls[4][1].headers["Mcp-Session-Id"]).toBe("new-session");
    expect(JSON.parse(fetch.mock.calls[4][1].body).method).toBe("tools/call");
  });

  it("reports the retried 404 after session refresh instead of looping", async () => {
    const { connectMcpServer, callMcpTool } = await import("./index");

    fetch
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "old-session" }
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [] }
      }))
      .mockResolvedValueOnce(mockJsonResponse("expired", { status: 404 }))
      .mockResolvedValueOnce(mockJsonResponse({
        jsonrpc: "2.0",
        id: 4,
        result: { serverInfo: { name: "Docs" }, capabilities: {} }
      }, {
        headers: { "Mcp-Session-Id": "new-session" }
      }))
      .mockResolvedValueOnce(mockJsonResponse("still expired", { status: 404 }));

    await connectMcpServer("https://mcp.example/rpc", {});

    await expect(callMcpTool("https://mcp.example/rpc", {}, "lookup", {}))
      .rejects.toThrow("MCP error 404: still expired");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe("MCP extension transport", () => {
  beforeEach(async () => {
    vi.resetModules();
    globalThis.fetch = vi.fn();
    chrome.runtime.sendMessage = vi.fn((extensionId, message, callback) => {
      if (message.method === "initialize") {
        callback({
          jsonrpc: "2.0",
          id: message.id,
          result: { serverInfo: { name: "Cookie Helper" }, capabilities: { tools: {} } }
        });
        return;
      }
      if (message.method === "tools/list") {
        callback({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "get_cookie", inputSchema: { type: "object" } }] }
        });
        return;
      }
      if (message.method === "tools/call") {
        callback({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "cookie-value" }] }
        });
      }
    });
  });

  it("connects and calls tools through another extension id", async () => {
    const { connectMcpServer, callMcpTool } = await import("./index");

    await expect(connectMcpServer({ type: "extension", extensionId: "cookie-helper-id", name: "cookie_helper" }))
      .resolves.toMatchObject({ name: "Cookie Helper", tools: [{ name: "get_cookie" }] });
    await expect(callMcpTool({ type: "extension", extensionId: "cookie-helper-id" }, {}, "get_cookie", { url: "https://example.com", name: "sid" }))
      .resolves.toEqual({ result: "cookie-value" });

    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      "cookie-helper-id",
      expect.objectContaining({ method: "initialize" }),
      expect.any(Function)
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      "cookie-helper-id",
      expect.objectContaining({ method: "tools/call" }),
      expect.any(Function)
    );
  });
});
