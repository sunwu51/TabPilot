/* eslint-disable react/prop-types */
import { render, screen } from "@testing-library/react";
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
});
