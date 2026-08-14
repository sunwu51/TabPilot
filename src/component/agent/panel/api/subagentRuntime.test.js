import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../../../../api/llm";
import {
  buildSubagentStepTitle,
  runSubagent,
  summarizeSubagentStep,
  truncateSubagentText
} from "./subagentRuntime";

vi.mock("../../../../api/llm", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, streamChat: vi.fn() };
});

const streamChatMock = vi.mocked(streamChat);

function emitToolCallMessage(toolCalls) {
  return {
    content: null,
    toolCalls,
    _openaiToolCalls: toolCalls.map(tc => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
    }))
  };
}

describe("subagentRuntime", () => {
  beforeEach(() => {
    streamChatMock.mockReset();
  });

  it("builds step titles and summaries", () => {
    expect(buildSubagentStepTitle({ name: "tab_extract", args: { tabId: 3 } })).toBe("tab_extract(tabId=3)");
    expect(buildSubagentStepTitle({ name: "tab_list", args: {} })).toBe("tab_list");
    expect(summarizeSubagentStep({ error: "network down" })).toBe("error: network down");
    expect(summarizeSubagentStep({ count: 3 })).toBe("{\"count\":3}");
    expect(truncateSubagentText("a".repeat(500))).toHaveLength(200);
    expect(truncateSubagentText("a".repeat(500)).endsWith("…")).toBe(true);
  });

  it("rejects an empty task before making any request", async () => {
    const invokeTool = vi.fn();
    const result = await runSubagent({ task: "   " }, { config: {}, invokeTool });

    expect(result.success).toBe(false);
    expect(result.code).toBe("SUBAGENT_INVALID_TASK");
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("returns the final answer and keeps no persisted history", async () => {
    streamChatMock.mockImplementationOnce((config, messages, callbacks) => {
      expect(messages[0]).toEqual({ role: "system", content: expect.any(String) });
      callbacks.onDone({ content: "resolved answer" });
      return () => {};
    });

    const result = await runSubagent(
      { task: "research the topic" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool: vi.fn() }
    );

    expect(result.success).toBe(true);
    expect(result.answer).toBe("resolved answer");
    expect(result.steps).toEqual([]);
    expect(result.toolCallCount).toBe(0);
  });

  it("runs the sub-agent in code mode and excludes host-context tools", async () => {
    let capturedOptions;
    streamChatMock.mockImplementationOnce((config, messages, callbacks, mcpTools, options) => {
      capturedOptions = options;
      callbacks.onDone({ content: "ok" });
      return () => {};
    });

    await runSubagent(
      { task: "do the thing" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool: vi.fn() }
    );

    expect(capturedOptions.useCodeMode).toBe(true);
    expect(capturedOptions.excludeToolNames).toContain("create_subagent");
    expect(capturedOptions.excludeToolNames).toContain("plan_create_for_session");
    expect(capturedOptions.excludeToolNames).toContain("request_user_input");
  });

  it("blocks nested create_subagent and records the failed step", async () => {
    const invokeTool = vi.fn(async () => ({ ok: true }));
    streamChatMock
      .mockImplementationOnce((config, messages, callbacks) => {
        callbacks.onDone(emitToolCallMessage([{ id: "c1", name: "create_subagent", args: { task: "nested" } }]));
        return () => {};
      })
      .mockImplementationOnce((config, messages, callbacks) => {
        callbacks.onDone({ content: "final answer" });
        return () => {};
      });

    const onStep = vi.fn();
    const result = await runSubagent(
      { task: "outer task" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool, onStep }
    );

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.answer).toBe("final answer");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].name).toBe("create_subagent");
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].error).toContain("cannot create");
    expect(onStep).toHaveBeenCalled();
  });

  it("records one summary per nested tool call, including errors", async () => {
    const invokeTool = vi.fn(async name => (name === "tab_open" ? { error: "boom" } : { count: 3 }));
    streamChatMock
      .mockImplementationOnce((config, messages, callbacks) => {
        callbacks.onDone(emitToolCallMessage([
          { id: "c1", name: "tab_list", args: {} },
          { id: "c2", name: "tab_open", args: { url: "https://example.com" } }
        ]));
        return () => {};
      })
      .mockImplementationOnce((config, messages, callbacks) => {
        callbacks.onDone({ content: "all done" });
        return () => {};
      });

    const result = await runSubagent(
      { task: "do the thing" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool }
    );

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.steps.map(step => step.status)).toEqual(["completed", "error"]);
    expect(result.steps[0].summary).toBe("{\"count\":3}");
    expect(result.steps[1].summary).toBe("error: boom");
  });

  it("expands exec nested calls into individual steps", async () => {
    const invokeTool = vi.fn(async name => {
      if (name === "exec") {
        return {
          status: "completed",
          value: { done: true },
          _subagentNestedCalls: [
            { name: "tab_list", title: "tab_list()", summary: "{\"count\":3}", status: "completed", durationMs: 5 },
            { name: "mcp.docs.search", title: "mcp.docs.search(query=bug)", summary: "{\"total\":2}", status: "completed", durationMs: 8 }
          ]
        };
      }
      return { ok: true };
    });
    streamChatMock
      .mockImplementationOnce((config, messages, callbacks) => {
        callbacks.onDone(emitToolCallMessage([{ id: "c1", name: "exec", args: { code: "..." } }]));
        return () => {};
      })
      .mockImplementationOnce((config, messages, callbacks) => {
        callbacks.onDone({ content: "done" });
        return () => {};
      });

    const result = await runSubagent(
      { task: "do the thing" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool }
    );

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map(step => step.title)).toEqual(["tab_list()", "mcp.docs.search(query=bug)"]);
    expect(result.steps.map(step => step.status)).toEqual(["completed", "completed"]);
    // The nested metadata must not leak into the tool result sent back to the sub-agent LLM.
    expect(result.steps.some(step => step.name === "exec")).toBe(false);
  });

  it("surfaces an LLM stream error without throwing", async () => {
    streamChatMock.mockImplementationOnce((config, messages, callbacks) => {
      callbacks.onError({ message: "network down" });
      return () => {};
    });

    const result = await runSubagent(
      { task: "do the thing" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool: vi.fn() }
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("SUBAGENT_LLM_ERROR");
    expect(result.error).toBe("network down");
  });

  it("records native web search as a visible step and fills in the query when it arrives", async () => {
    streamChatMock.mockImplementationOnce((config, messages, callbacks) => {
      callbacks.onNativeWebSearch?.({ id: "ws_1", status: "in_progress", action: {} });
      callbacks.onNativeWebSearch?.({ id: "ws_1", status: "completed", action: { type: "search", query: "openai" } });
      callbacks.onDone({ content: "searched" });
      return () => {};
    });

    const result = await runSubagent(
      { task: "search the web" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool: vi.fn() }
    );

    expect(result.success).toBe(true);
    expect(result.answer).toBe("searched");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].name).toBe("web_search");
    expect(result.steps[0].title).toBe("search: openai");
    expect(result.steps[0].status).toBe("completed");
  });

  it("reconciles web search titles from the final message's web_searches", async () => {
    streamChatMock.mockImplementationOnce((config, messages, callbacks) => {
      callbacks.onNativeWebSearch?.({ id: "ws_1", status: "completed", action: {} });
      callbacks.onDone({
        content: "searched",
        web_searches: [{ id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "reconciled query" } }]
      });
      return () => {};
    });

    const result = await runSubagent(
      { task: "search the web" },
      { config: { apiType: "openai", model: "test-model" }, invokeTool: vi.fn() }
    );

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].title).toBe("search: reconciled query");
  });
});
