/* global chrome */
/* eslint-disable react/prop-types */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, isDisabled, ...props }) => (
    <button type="button" onClick={onPress} disabled={isDisabled} {...props}>{children}</button>
  ),
  Card: ({ children }) => <div>{children}</div>,
  Dialog: ({ children, trigger }) => (
    <div>
      {trigger || null}
      {children}
    </div>
  )
}));

vi.mock("react-hot-toast", () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}));

vi.mock("./McpConfig", () => ({ default: () => null }));
vi.mock("./UserProfilePanel", () => ({ default: () => null }));
vi.mock("./SkillsConfig", () => ({ default: () => null }));

import AgentPanel, { buildImageModelSystemPrompt, buildToolExecutionBatches, finalizeInterruptedToolMessages, runToolExecutionBatches } from "./AgentPanel";
import { getChromeStorageSnapshot, resetChromeMock } from "../../../test/setup";

describe("AgentPanel initial session restore", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  });

  it("builds image model profile guidance for the system prompt", () => {
    const prompt = buildImageModelSystemPrompt({
      activeImageModelId: "img_a3f09c",
      imageModels: [
        {
          id: "img_a3f09c",
          name: "OpenAI image",
          imageBaseUrl: "https://api.openai.com/v1",
          imageApiKey: "token",
          imageApiProtocol: "generate",
          imageModel: "gpt-image-2"
        },
        {
          id: "img_b4d101",
          name: "Poster model",
          imageBaseUrl: "https://image.example/v1",
          imageApiKey: "token",
          imageApiProtocol: "chat_completions",
          imageModel: "poster-image"
        }
      ]
    });

    expect(prompt).toContain("Configured Image model profiles");
    expect(prompt).toContain("id=img_a3f09c: modelName=gpt-image-2; default");
    expect(prompt).toContain("id=img_b4d101: modelName=poster-image");
    expect(prompt).toContain("image_model_id");
    expect(prompt).not.toContain("OpenAI image");
    expect(prompt).not.toContain("Poster model");
    expect(prompt).not.toContain("chat_completions");
    expect(prompt).not.toContain("token");
    expect(prompt).not.toContain("api.openai.com");
  });

  it("finalizes pending tool messages as interrupted", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "tool",
        tool_call_id: "c1",
        tool_name: "create_subagent",
        content: null,
        _pending: true,
        _subagentRuns: [{ name: "tab_list", status: "running" }, { name: "tab_open", status: "completed" }]
      },
      { role: "tool", tool_call_id: "c2", tool_name: "tab_list", content: "{}" }
    ];

    const result = finalizeInterruptedToolMessages(messages);

    expect(result[0]).toEqual(messages[0]);
    expect(result[1]._pending).toBe(false);
    expect(result[1].content).toContain("Interrupted");
    expect(result[1]._subagentRuns[0].status).toBe("error");
    expect(result[1]._subagentRuns[1].status).toBe("completed");
    expect(result[2]).toEqual(messages[2]);
  });

  it("batches only consecutive image tools for parallel execution", () => {
    const batches = buildToolExecutionBatches([
      { id: "call_1", name: "image_gen" },
      { id: "call_2", name: "image_edit" },
      { id: "call_3", name: "tab_list" },
      { id: "call_4", name: "image_gen" },
      { id: "call_5", name: "download_search" }
    ]);

    expect(batches).toEqual([
      {
        parallel: true,
        toolCalls: [
          { id: "call_1", name: "image_gen" },
          { id: "call_2", name: "image_edit" }
        ]
      },
      { parallel: false, toolCalls: [{ id: "call_3", name: "tab_list" }] },
      { parallel: true, toolCalls: [{ id: "call_4", name: "image_gen" }] },
      { parallel: false, toolCalls: [{ id: "call_5", name: "download_search" }] }
    ]);
  });

  it("starts image tools together and applies each result as it finishes", async () => {
    const started = [];
    const applied = [];
    const resolvers = new Map();
    const runPromise = runToolExecutionBatches([
      { id: "call_1", name: "image_gen" },
      { id: "call_2", name: "image_gen" }
    ], (toolCall) => {
      started.push(toolCall.id);
      return new Promise(resolve => {
        resolvers.set(toolCall.id, () => resolve({ id: toolCall.id, name: toolCall.name, result: { success: true } }));
      });
    }, (toolResult) => {
      applied.push(toolResult.id);
    });

    await Promise.resolve();
    expect(started).toEqual(["call_1", "call_2"]);
    expect(applied).toEqual([]);

    resolvers.get("call_2")();
    await Promise.resolve();
    expect(applied).toEqual(["call_2"]);

    resolvers.get("call_1")();
    await expect(runPromise).resolves.toEqual([
      { id: "call_1", name: "image_gen", result: { success: true } },
      { id: "call_2", name: "image_gen", result: { success: true } }
    ]);
    expect(applied).toEqual(["call_2", "call_1"]);
  });

  it("hydrates stored session images when restoring the last active session on mount", async () => {
    const dataUrl = "data:image/png;base64,dXNlcg==";
    resetChromeMock({
      sessions_index: [{
        id: "a",
        title: "图片会话",
        updatedAt: 1,
        startedAt: 1,
        manualTitle: false
      }],
      agent_last_active_session_id: "a",
      session_a: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "请看图片" },
            { type: "image", source: { type: "session_image", ref: "img_1", media_type: "image/png" } }
          ]
        }]
      },
      session_a_images: {
        img_1: dataUrl
      }
    });
    chrome.runtime.getPlatformInfo = vi.fn((callback) => {
      callback?.({ os: "mac" });
      return Promise.resolve({ os: "mac" });
    });

    render(<AgentPanel />);

    const image = await screen.findByAltText("用户上传的图片");
    await waitFor(() => {
      expect(image).toHaveAttribute("src", dataUrl);
    });
    expect(screen.queryByText("图片加载中...")).not.toBeInTheDocument();
  });

  it("silently restores another unlocked session when the preferred session is locked by another window", async () => {
    resetChromeMock({
      sessions_index: [
        { id: "a", title: "锁定会话", updatedAt: 2, startedAt: 2, manualTitle: false },
        { id: "b", title: "可打开会话", updatedAt: 1, startedAt: 1, manualTitle: false }
      ],
      agent_last_active_session_id: "a",
      agent_session_locks: {
        a: { windowId: "2", updatedAt: Date.now() }
      },
      session_a: { messages: [{ role: "user", content: "locked" }] },
      session_b: { messages: [{ role: "user", content: "unlocked" }] }
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AgentPanel />);

    await waitFor(() => {
      expect(getChromeStorageSnapshot().agent_last_active_session_id).toBe("b");
    });
    expect(screen.queryByText("locked")).not.toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("creates a fresh session on startup when every existing session is locked by another window", async () => {
    resetChromeMock({
      sessions_index: [
        { id: "a", title: "锁定一", updatedAt: 2, startedAt: 2, manualTitle: false },
        { id: "b", title: "锁定二", updatedAt: 1, startedAt: 1, manualTitle: false }
      ],
      agent_last_active_session_id: "a",
      agent_session_locks: {
        a: { windowId: "2", updatedAt: Date.now() },
        b: { windowId: "3", updatedAt: Date.now() }
      },
      session_a: { messages: [{ role: "user", content: "locked a" }] },
      session_b: { messages: [{ role: "user", content: "locked b" }] }
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AgentPanel />);

    await waitFor(() => {
      const storage = getChromeStorageSnapshot();
      expect(storage.sessions_index).toHaveLength(3);
      const created = storage.sessions_index.find(session => session.id !== "a" && session.id !== "b");
      expect(created).toMatchObject({ title: "新会话" });
      expect(storage.agent_last_active_session_id).toBe(created.id);
      expect(storage.agent_session_locks[created.id]?.windowId).toBe("1");
    });
    expect(screen.queryByText("locked a")).not.toBeInTheDocument();
    expect(screen.queryByText("locked b")).not.toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
