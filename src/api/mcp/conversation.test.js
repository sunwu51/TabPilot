import { beforeEach, describe, expect, it, vi } from "vitest";
/* global chrome */

const URL_A = "https://mcp.example/rpc";
const HEADERS = { Authorization: "Bearer token" };

function reply(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body)))
  };
}

/**
 * A tiny stateful MCP server: initialize issues a numbered session id, tools/call echoes
 * the session id it was called with, unknown ids get 404, DELETE forgets the id.
 */
function installServer({ stateless = false } = {}) {
  const state = { next: 1, live: new Set(), initializes: 0, deletes: [], calls: [] };
  globalThis.fetch = vi.fn(async (_url, init) => {
    const sessionId = init.headers["Mcp-Session-Id"];
    if (init.method === "DELETE") {
      state.deletes.push(sessionId);
      state.live.delete(sessionId);
      return reply({ terminated: true });
    }
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      state.initializes += 1;
      if (stateless) return reply({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "S" } } });
      const id = `sess-${state.next++}`;
      state.live.add(id);
      return reply({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "S" } } }, { headers: { "Mcp-Session-Id": id } });
    }
    if (!stateless && !state.live.has(sessionId)) {
      return reply("session expired", { status: 404 });
    }
    state.calls.push({ method: body.method, sessionId });
    if (body.method === "tools/call" && body.params.name === "boom") {
      return reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
    }
    return reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ session: sessionId ?? null }) }] } });
  });
  return state;
}

async function freshModule() {
  vi.resetModules();
  return await import("./index");
}

describe("per-conversation MCP sessions", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it("gives each conversation its own Mcp-Session-Id and reuses it", async () => {
    const server = installServer();
    const { callMcpTool } = await freshModule();

    const first = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    const second = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-2" });
    const firstAgain = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });

    expect(first.result.session).toBe("sess-1");
    expect(second.result.session).toBe("sess-2");
    expect(firstAgain.result.session).toBe("sess-1");
    expect(server.initializes).toBe(2);
  });

  it("keeps calls without a conversation on the legacy shared session", async () => {
    const server = installServer();
    const { connectMcpServer, callMcpTool } = await freshModule();

    await connectMcpServer(URL_A, HEADERS);
    const shared = await callMcpTool(URL_A, HEADERS, "t", {});
    const conversation = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });

    expect(shared.result.session).toBe("sess-1");
    expect(conversation.result.session).not.toBe(shared.result.session);
    expect(server.initializes).toBe(2);
  });

  it("starts one initialize for concurrent first calls of a conversation", async () => {
    const server = installServer();
    const { callMcpTool } = await freshModule();

    const results = await Promise.all([1, 2, 3].map(() => callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" })));

    expect(results.every(item => item.result.session === "sess-1")).toBe(true);
    expect(server.initializes).toBe(1);
  });

  it("survives a reload: the stored session id is reused without initializing again", async () => {
    const server = installServer();
    let { callMcpTool } = await freshModule();
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });

    ({ callMcpTool } = await freshModule()); // side panel closed and reopened; storage persists
    const after = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });

    expect(after.result.session).toBe("sess-1");
    expect(server.initializes).toBe(1);
    const stored = (await chrome.storage.local.get("mcp_conversation_sessions")).mcp_conversation_sessions;
    expect(JSON.stringify(stored)).not.toContain("token");
  });

  it("tells the model when its session was renewed after a 404", async () => {
    const server = installServer();
    const { callMcpTool } = await freshModule();
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    server.live.clear(); // the server restarted or expired the session

    const renewed = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    const next = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });

    expect(renewed.result.session).toBe("sess-2");
    expect(renewed.mcp_session_notice).toMatch(/new session/);
    expect(next.result.session).toBe("sess-2");
    expect(next.mcp_session_notice).toBeUndefined();
    const stored = (await chrome.storage.local.get("mcp_conversation_sessions")).mcp_conversation_sessions;
    expect(Object.values(stored["chat-1"])[0].id).toBe("sess-2");
  });

  it("does not loop when a fresh session is rejected too", async () => {
    installServer();
    const { callMcpTool } = await freshModule();
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "initialize") return reply({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "Mcp-Session-Id": "sess-x" } });
      return reply("gone", { status: 404 });
    });

    await expect(callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" })).rejects.toThrow(/404/);
    expect(fetch.mock.calls.filter(([, init]) => JSON.parse(init.body).method === "initialize")).toHaveLength(1);
  });

  it("does not re-initialize for stateless servers that issue no session id", async () => {
    const server = installServer({ stateless: true });
    const { callMcpTool } = await freshModule();

    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-2" });

    expect(server.initializes).toBe(2);
    expect(server.calls.every(call => call.sessionId === undefined)).toBe(true);
  });

  it("reports tool-level isError results as errors", async () => {
    installServer();
    const { callMcpTool } = await freshModule();
    await expect(callMcpTool(URL_A, HEADERS, "boom", {}, 60000, { conversationId: "chat-1" }))
      .resolves.toEqual({ error: "it broke" });
  });

  it("releases a conversation by ending its sessions on the server and forgetting them", async () => {
    const server = installServer();
    const { callMcpTool, releaseMcpConversation } = await freshModule();
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-2" });

    await releaseMcpConversation("chat-1", [
      { _serverUrl: URL_A, _serverHeaders: HEADERS, _serverType: "http" },
      { _serverType: "extension", _serverExtensionId: "x".repeat(32) }
    ]);

    expect(server.deletes).toEqual(["sess-1"]);
    const stored = (await chrome.storage.local.get("mcp_conversation_sessions")).mcp_conversation_sessions;
    expect(Object.keys(stored)).toEqual(["chat-2"]);
    // A later message in a recreated conversation with the same id starts clean.
    const again = await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });
    expect(again.result.session).toBe("sess-3");
  });

  it("ignores release for a conversation without sessions", async () => {
    installServer();
    const { releaseMcpConversation } = await freshModule();
    await expect(releaseMcpConversation("never-used", [{ _serverUrl: URL_A, _serverHeaders: HEADERS, _serverType: "http" }])).resolves.toBeUndefined();
    await expect(releaseMcpConversation("", [])).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops stored sessions that have not been used for 90 days", async () => {
    installServer();
    const { callMcpTool } = await freshModule();
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
    await chrome.storage.local.set({
      mcp_conversation_sessions: { stale: { "https://other.example/rpc#00000000": { id: "old", updatedAt: old } } }
    });

    await callMcpTool(URL_A, HEADERS, "t", {}, 60000, { conversationId: "chat-1" });

    const stored = (await chrome.storage.local.get("mcp_conversation_sessions")).mcp_conversation_sessions;
    expect(Object.keys(stored)).toEqual(["chat-1"]);
  });
});
