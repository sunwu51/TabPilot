/* eslint-disable react/prop-types */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ streamChat: vi.fn(), createGate: null }));

vi.mock("../../api/llm", async (importOriginal) => ({
  ...await importOriginal(),
  streamChat: mocks.streamChat
}));
vi.mock("../../api/agent/sessions", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSession: async (...args) => {
      if (mocks.createGate) await mocks.createGate;
      return actual.createSession(...args);
    }
  };
});
vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, isDisabled, ...props }) => (
    <button type="button" onClick={onPress} disabled={isDisabled} {...props}>{children}</button>
  ),
  Card: ({ children }) => <div>{children}</div>,
  Dialog: ({ trigger }) => <>{trigger}</>
}));
vi.mock("./McpConfig", () => ({ default: () => null }));
vi.mock("./UserProfilePanel", () => ({ default: () => null }));
vi.mock("./SkillsConfig", () => ({ default: () => null }));

import AgentPanel from "./AgentPanel";
import { getChromeStorageSnapshot, resetChromeMock } from "../../../test/setup";

describe("AgentPanel approvals when creating a session", () => {
  afterEach(cleanup);
  beforeAll(() => {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.requestAnimationFrame = callback => setTimeout(() => callback(0), 0);
    globalThis.cancelAnimationFrame = id => clearTimeout(id);
  });

  beforeEach(() => {
    mocks.createGate = null;
    mocks.streamChat.mockReset().mockReturnValue(vi.fn());
    resetChromeMock({
      sessions_index: [{ id: "a", title: "原会话", updatedAt: 1, startedAt: 1, manualTitle: true }],
      agent_last_active_session_id: "a",
      session_a: { messages: [{ role: "user", content: "原会话消息" }] },
      llmConfig: {
        activeLlmModelId: "model_test",
        llmModels: [{ id: "model_test", apiType: "openai-chat-completions", baseUrl: "https://example.com/v1", apiKey: "test", model: "test" }]
      }
    });
  });

  async function startRun() {
    render(<AgentPanel />);
    await screen.findByText("原会话消息", { selector: ".chat-bubble-user" });
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: "帮我执行一个计划" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1));
    return mocks.streamChat.mock.calls[0][2];
  }

  function requestPlan(callbacks) {
    act(() => {
      void callbacks.onDone({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "plan_call", name: "plan_create_for_session", args: { title: "原会话的计划", steps: [{ title: "完成任务" }] } }]
      });
    });
  }

  async function expectNewSession() {
    await waitFor(() => expect(getChromeStorageSnapshot().agent_last_active_session_id).not.toBe("a"));
    await waitFor(() => expect(screen.queryByText("原会话消息", { selector: ".chat-bubble-user" })).not.toBeInTheDocument());
    expect(screen.queryByText("执行计划待确认")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  }

  async function returnAndApprovePlan() {
    fireEvent.click(screen.getByTitle("历史"));
    fireEvent.click(await screen.findByText(/原会话/, { selector: ".chat-history-item-title" }));
    await screen.findByText("执行计划待确认");
    fireEvent.click(screen.getByRole("button", { name: "OK，开始实施" }));
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(2));
    expect(mocks.streamChat.mock.calls[1][4].sessionId).toBe("a");
  }

  it("clears a visible plan card in the new session and preserves approval in the original session", async () => {
    const callbacks = await startRun();
    requestPlan(callbacks);
    await screen.findByText("执行计划待确认");
    fireEvent.click(screen.getByTitle("新建"));
    await expectNewSession();
    await returnAndApprovePlan();
  });

  it("clears a plan arriving while the new session is being created", async () => {
    const callbacks = await startRun();
    let finishCreating;
    mocks.createGate = new Promise(resolve => { finishCreating = resolve; });
    fireEvent.click(screen.getByTitle("新建"));
    requestPlan(callbacks);
    await screen.findByText("执行计划待确认");
    await act(async () => { finishCreating(); });
    await expectNewSession();
    await returnAndApprovePlan();
  });

  it("keeps a plan arriving after the switch scoped to the original session", async () => {
    const callbacks = await startRun();
    fireEvent.click(screen.getByTitle("新建"));
    await expectNewSession();
    requestPlan(callbacks);
    await waitFor(() => expect(getChromeStorageSnapshot().session_a?.plans).toHaveLength(1));
    expect(screen.queryByText("执行计划待确认")).not.toBeInTheDocument();
    await returnAndApprovePlan();
  });
});
