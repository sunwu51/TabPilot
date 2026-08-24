import { describe, expect, it, vi } from "vitest";
import { createHookLlmRuntime, runAroundHooks } from "./hooks";

describe("agent hooks", () => {
  it("chains changes and returns each hook state in reverse completion order", async () => {
    const calls = [];
    const hooks = [{ id: "a", name: "A", event: "tool.call", code: `async ({ phase, context, state }) => {
      if (phase === "before") return { changes: { args: { value: context.data.args.value + 1 } }, state: "a" };
    }` }];
    const builtin = { id: "b", priority: 1, run: async ({ phase, context, state }) => {
      calls.push([phase, context.data.args.value, state]);
      if (phase === "before") return { changes: { args: { value: context.data.args.value * 2 } }, state: "b" };
    } };
    const result = await runAroundHooks({ event: "tool.call", context: { data: { args: { value: 2 } } }, hooks, builtins: [builtin], operation: async data => data.args.value });
    expect(result.result).toBe(5);
    expect(calls).toEqual([["before", 2, null], ["after", 5, "b"]]);
  });

  it("skips a failed hook and continues the operation", async () => {
    const operation = vi.fn(async () => "ok");
    const result = await runAroundHooks({ event: "tool.call", context: { data: {} }, hooks: [{ id: "bad", event: "tool.call", code: "async () => { throw new Error('bad'); }" }], operation, onDiagnostic: vi.fn() });
    expect(result.result).toBe("ok");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("accepts a function body in addition to a function expression", async () => {
    const result = await runAroundHooks({
      event: "tool.call",
      context: { data: { args: { value: 1 } } },
      hooks: [{ id: "body", event: "tool.call", code: "if (phase === 'before') return { changes: { args: { value: 2 } } };" }],
      operation: async data => data.args.value
    });
    expect(result.result).toBe(2);
  });

  it("injects host fetch and chrome capabilities explicitly", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const chromeMock = { storage: { local: { get: vi.fn(async () => ({ ok: true })) } } };
    const result = await runAroundHooks({
      event: "tool.call",
      context: { data: {} },
      runtime: { fetch: fetchMock, chrome: chromeMock },
      hooks: [{ id: "host", event: "tool.call", code: `async ({ phase }) => {
        if (phase === "before") {
          const response = await fetch("https://example.com");
          const value = await chrome.storage.local.get("x");
          return { state: { ok: response.ok && value.ok } };
        }
      }` }],
      operation: async () => "ok"
    });
    expect(result.result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com");
    expect(chromeMock.storage.local.get).toHaveBeenCalledWith("x");
  });

  it("exposes public LLM profiles and completes with the selected profile", async () => {
    const runtime = createHookLlmRuntime({
      llmModels: [{ id: "profile_a", name: "Memory model", model: "memory-model", apiType: "openai_chat_completions", baseUrl: "https://example.test/v1", apiKey: "secret" }],
      activeLlmModelId: "profile_a"
    });
    expect(runtime.profiles()).toEqual([expect.objectContaining({ id: "llm_opencode_zen_big_pickle" }), expect.objectContaining({ id: "profile_a", model: "memory-model" })]);
    expect(JSON.stringify(runtime.profiles())).not.toContain("secret");
  });
});
