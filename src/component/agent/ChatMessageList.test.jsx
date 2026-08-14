import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ChatMessage", () => ({
  default: ({ msg, messageIndex }) => (
    <div data-testid={`message-${messageIndex}`}>{typeof msg.content === "string" ? msg.content : msg.role}</div>
  ),
  EditableChatImage: () => null
}));

import ChatMessageList from "./ChatMessageList";

describe("ChatMessageList", () => {
  it("shows the compaction divider after the visible group containing the display index", () => {
    render(
      <ChatMessageList
        messages={[
          { role: "user", content: "start" },
          { role: "assistant", content: "calling", tool_calls: [{ id: "call_1", function: { name: "tab_list", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", tool_name: "tab_list", content: "{\"ok\":true}" },
          { role: "assistant", content: "done" }
        ]}
        contextCompaction={{
          status: "compressing",
          coveredMessageIndex: 0,
          displayMessageIndex: 1
        }}
      />
    );

    const divider = screen.getByText("正在压缩会话内容").closest(".context-compressed-divider");
    const nextMessage = screen.getByTestId("message-3");
    expect(divider).not.toBeNull();
    expect(screen.getAllByText(/tab_list/).length).toBeGreaterThan(0);
    expect(divider.compareDocumentPosition(nextMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("splits a long tool group when the compaction divider lands in the middle", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: "tool",
      tool_call_id: `call_${index}`,
      tool_name: `tool_${index}`,
      content: "{\"ok\":true}"
    }));

    render(
      <ChatMessageList
        messages={messages}
        contextSummary={{
          version: 1,
          coveredMessageIndex: 3,
          displayMessageIndex: 5,
          summary: "compacted"
        }}
      />
    );

    expect(screen.getByText("以上消息已经被压缩")).toBeTruthy();
    expect(screen.getAllByText("展开查看 6 个工具调用详情")).toHaveLength(2);
  });

  it("keeps a long tool group expanded while new tool results arrive", () => {
    const makeMessages = count => Array.from({ length: count }, (_, index) => ({
      role: "tool",
      tool_call_id: `call_${index}`,
      tool_name: `tool_${index}`,
      content: "{\"ok\":true}"
    }));
    const { rerender } = render(<ChatMessageList messages={makeMessages(6)} />);

    fireEvent.click(screen.getByText("展开查看 6 个工具调用详情"));
    expect(document.querySelector(".tool-result-arrow")?.textContent).toBe("▼");

    rerender(<ChatMessageList messages={makeMessages(7)} />);
    expect(screen.getByText("展开查看 7 个工具调用详情")).toBeTruthy();
    expect(document.querySelector(".tool-result-arrow")?.textContent).toBe("▼");
  });

  it("shows nested code-mode calls in the exec title and highlights the code input", () => {
    render(
      <ChatMessageList
        messages={[
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ code: "const tabs = await tools.tab_list({});\nreturn tabs;" }) } }]
          },
          {
            role: "tool",
            tool_call_id: "call_exec",
            tool_name: "exec",
            content: JSON.stringify({ status: "completed", value: { count: 0 } }),
            _codeToolCalls: [{ name: "tab_list", args: {}, status: "completed" }]
          }
        ]}
      />
    );

    const title = screen.getByText(/tab_list\(\)/);
    expect(title.textContent).not.toContain("exec:");
    expect(title.textContent).not.toContain("const tabs");
    fireEvent.click(title.closest(".tool-result-header"));
    const code = document.querySelector(".tool-exec-code-content code.language-javascript");
    expect(code).not.toBeNull();
    expect(code.textContent).toContain("await tools.tab_list");
    expect(code.innerHTML).toContain("hljs-keyword");
  });

  it("serializes object-valued tool arguments instead of rendering object coercion", () => {
    render(
      <ChatMessageList
        messages={[
          { role: "assistant", tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_exec", tool_name: "exec", content: "{}", _codeToolCalls: [{ name: "tab_list", args: { query: { active: true } } }] }
        ]}
      />
    );
    expect(screen.getByText(/tab_list\(\{"active":true\}\)/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("shows namespaced MCP calls in the exec card title", () => {
    render(
      <ChatMessageList
        messages={[
          { role: "assistant", tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: "{}" } }] },
          {
            role: "tool",
            tool_call_id: "call_exec",
            tool_name: "exec",
            content: "{}",
            _codeToolCalls: [{ name: "mcp.github.search-issues", args: { query: "bug" }, status: "completed" }]
          }
        ]}
      />
    );

    const title = screen.getByText(/mcp\.github\.search-issues\(bug\)/);
    expect(title.textContent).not.toContain("exec:");
  });

  it("shows runtime discovery helpers in the tool card title", () => {
    render(
      <ChatMessageList
        messages={[
          { role: "assistant", tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: "{}" } }] },
          {
            role: "tool",
            tool_call_id: "call_exec",
            tool_name: "exec",
            content: "{}",
            _codeToolCalls: [
              { name: "tools.listTools", args: { domain: "tabs" }, status: "completed" },
              { name: "tools.describeMcpTool", args: { serverName: "docs", toolName: "lookup" }, status: "completed" }
            ]
          }
        ]}
      />
    );

    const title = screen.getByText(/tools\.listTools\(\{"domain":"tabs"\}\).*tools\.describeMcpTool/);
    expect(title.textContent).not.toContain("exec:");
  });

  it("keeps structured exec errors out of the card title", () => {
    render(
      <ChatMessageList
        messages={[
          { role: "assistant", tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: "{}" } }] },
          {
            role: "tool",
            tool_call_id: "call_exec",
            tool_name: "exec",
            content: JSON.stringify({ status: "failed", error: { code: "RUNTIME_ERROR", message: "tabs is not iterable" } }),
            _codeToolCalls: [{ name: "tab_list", args: {}, status: "completed" }]
          }
        ]}
      />
    );

    const title = screen.getByText(/tab_list\(\)/);
    expect(title.textContent).not.toContain("exec:");
    expect(title.textContent).not.toContain("tabs is not iterable");
    expect(document.body.textContent).not.toContain("[object Object]");
    fireEvent.click(title.closest(".tool-result-header"));
    expect(screen.getByText(/"message": "tabs is not iterable"/)).toBeTruthy();
  });

  it("shows sub-agent run summaries inside an expanded create_subagent card", () => {
    render(
      <ChatMessageList
        messages={[
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_sub", function: { name: "create_subagent", arguments: JSON.stringify({ task: "research X" }) } }]
          },
          {
            role: "tool",
            tool_call_id: "call_sub",
            tool_name: "create_subagent",
            content: JSON.stringify({ success: true, answer: "done" }),
            _subagentRuns: [
              { name: "tab_list", title: "tab_list()", summary: "{\"count\":3}", status: "completed", durationMs: 10 },
              { name: "tab_extract", title: "tab_extract(tabId=3)", summary: "error: boom", status: "error", durationMs: 5 }
            ]
          }
        ]}
      />
    );

    const title = screen.getByText(/subagent · 2\/2 步 · 1 失败/);
    fireEvent.click(title.closest(".tool-result-header"));
    expect(screen.getByText("子 agent 执行记录")).toBeTruthy();
    expect(screen.getByText("tab_list()")).toBeTruthy();
    expect(screen.getByText("tab_extract(tabId=3)")).toBeTruthy();
    expect(screen.getByText("error: boom")).toBeTruthy();
  });
});
