/* global chrome */
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("background requests", () => {
  it("keeps page requests on runtime messaging", async () => {
    const { requestBackground } = await import("./requests");
    chrome.runtime.sendMessage.mockImplementation((message, callback) => callback({ success: true, data: message.payload }));
    await expect(requestBackground({ type: "postdog_manager", payload: { id: "r1" } }))
      .resolves.toEqual({ success: true, data: { id: "r1" } });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("executes worker-hosted tools locally without opening a runtime port", async () => {
    const { registerBackgroundRequestHandler } = await import("./requests");
    const { executeTool } = await import("../llm/tools/executor");
    const handler = vi.fn(async message => message.type === "schedule_manager"
      ? { success: true, scheduleId: "s1" }
      : { success: true, data: [], tabId: 1, report: { ok: true } });
    for (const type of ["postdog_manager", "macro_manager", "schedule_manager"]) {
      registerBackgroundRequestHandler(type, handler);
    }
    for (const [name, args] of [
      ["postdog_list_folders", {}], ["postdog_save_folder", { name: "folder" }],
      ["postdog_list_requests", {}], ["postdog_get_request", { id: "r1" }],
      ["postdog_save_request", { name: "request" }], ["postdog_run_request", { id: "r1" }],
      ["postdog_list_history", {}], ["postdog_get_history_run", { runId: "h1" }],
      ["postdog_list_environments", {}], ["postdog_save_environment", { name: "env" }],
      ["postdog_set_active_environment", { id: "e1" }],
      ["list_macros", {}], ["describe_macro", { id: "m1" }], ["run_macro", { id: "m1" }],
      ["schedule_agent", { prompt: "test" }]
    ]) {
      const result = await executeTool(name, args);
      expect(result.error, name).toBeUndefined();
    }
    expect(handler).toHaveBeenCalledTimes(15);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("gets subscription credentials locally in the worker", async () => {
    const { registerBackgroundRequestHandler } = await import("./requests");
    const { requestOpenAiSubscriptionAccess } = await import("../llm/providers/openai-subscription-auth");
    const handler = vi.fn(async () => ({ success: true, result: { accessToken: "test" } }));
    registerBackgroundRequestHandler("openai_subscription_oauth", handler);
    await expect(requestOpenAiSubscriptionAccess("p1", { force: true })).resolves.toEqual({ accessToken: "test" });
    expect(handler).toHaveBeenCalledWith({ type: "openai_subscription_oauth", action: "access", profileId: "p1", force: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("propagates runtime port errors", async () => {
    const { requestBackground } = await import("./requests");
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      chrome.runtime.lastError = { message: "port closed" };
      try { callback(); } finally { delete chrome.runtime.lastError; }
    });
    await expect(requestBackground({ type: "postdog_manager" })).rejects.toThrow("port closed");
  });
});
