import { describe, expect, it, vi } from "vitest";
import { resetChromeMock } from "../../../test/setup";

const executeTool = vi.fn();

vi.mock("../llm", () => ({
  TOOLS: [
    { name: "plan_create_for_session" },
    { name: "plan_update_for_session" },
    { name: "tool_list_group" },
    { name: "tool_enable" },
    { name: "image_gen" },
    { name: "image_edit" },
    { name: "tab_list" }
  ],
  executeTool,
  getBuiltinToolTimeoutSeconds: vi.fn(() => 600),
  isImageApiConfigured: vi.fn(() => true),
  isImageToolName: vi.fn((name) => name === "image_gen" || name === "image_edit")
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "closed" });
  }
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe("wsBridge tool execution queue", () => {
  it("does not expose session-only planning and tool-selection helpers", async () => {
    resetChromeMock();
    chrome.runtime.sendMessage = vi.fn(() => Promise.resolve());
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket;
    vi.resetModules();

    const { connectWsBridge } = await import("./wsBridge");
    await connectWsBridge("ws://localhost:8787");
    const socket = MockWebSocket.instances[0];
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });

    await flushMicrotasks();
    const response = socket.sent.map(item => JSON.parse(item)).find(item => item.id === 1);
    expect(response.result.tools.map(tool => tool.name)).toEqual(["image_gen", "image_edit", "tab_list"]);
  });

  it("does not queue image tools behind other image tools", async () => {
    resetChromeMock();
    chrome.runtime.sendMessage = vi.fn(() => Promise.resolve());
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket;
    vi.resetModules();

    const resolvers = new Map();
    const started = [];
    executeTool.mockImplementation((name) => {
      started.push(name);
      return new Promise(resolve => {
        resolvers.set(name, resolve);
      });
    });

    const { connectWsBridge } = await import("./wsBridge");
    await connectWsBridge("ws://localhost:8787");
    const socket = MockWebSocket.instances[0];
    socket.onopen?.();

    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "image_gen", arguments: {} } })
    });
    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_edit", arguments: {} } })
    });

    await flushMicrotasks();
    expect(started).toEqual(["image_gen", "image_edit"]);

    resolvers.get("image_edit")({ success: true, second: true });
    await flushMicrotasks();
    expect(socket.sent.map(item => JSON.parse(item).id)).toContain(2);
    expect(socket.sent.map(item => JSON.parse(item).id)).not.toContain(1);

    resolvers.get("image_gen")({ success: true, first: true });
    await flushMicrotasks();
    expect(socket.sent.map(item => JSON.parse(item).id)).toEqual([2, 1]);
  });

  it("keeps non-image tools serialized", async () => {
    resetChromeMock();
    chrome.runtime.sendMessage = vi.fn(() => Promise.resolve());
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket;
    vi.resetModules();

    const resolvers = [];
    const started = [];
    executeTool.mockImplementation((name) => {
      started.push(name);
      return new Promise(resolve => {
        resolvers.push(resolve);
      });
    });

    const { connectWsBridge } = await import("./wsBridge");
    await connectWsBridge("ws://localhost:8787");
    const socket = MockWebSocket.instances[0];
    socket.onopen?.();

    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tab_list", arguments: {} } })
    });
    socket.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tab_list", arguments: {} } })
    });

    await flushMicrotasks();
    expect(started).toEqual(["tab_list"]);

    resolvers[0]({ success: true, first: true });
    await flushMicrotasks();
    expect(started).toEqual(["tab_list", "tab_list"]);
  });
});
