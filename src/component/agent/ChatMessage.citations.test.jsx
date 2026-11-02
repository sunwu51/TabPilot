/* global chrome */
/* eslint-disable react/prop-types */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, ...props }) => <button type="button" onClick={onPress} {...props}>{children}</button>,
  Dialog: ({ children, trigger }) => <div>{trigger}{children}</div>
}));

import ChatMessage from "./ChatMessage";
import ChatMessageList from "./ChatMessageList";

function buildSearchToolMessages(count) {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_input", function: { name: "request_user_input", arguments: "{}" } }]
    },
    { role: "tool", tool_call_id: "call_input", tool_name: "request_user_input", content: "{}" },
    ...Array.from({ length: count }, (_, index) => [
      {
        role: "assistant",
        content: index === 0 ? "Continuing research." : null,
        ...(index === 0 ? { web_searches: [{ type: "search", query: "native search regression" }] } : {}),
        tool_calls: [{ id: `call_${index}`, function: { name: "tab_list", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: `call_${index}`, tool_name: "tab_list", content: "{}" }
    ]).flat()
  ];
}

describe("ChatMessage citations and web search", () => {
  it("renders web search actions bubble and citations bubble for Anthropic message", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the information found." }
      ],
      web_searches: [
        { type: "search", query: "Claude web search release date" }
      ],
      citations: [
        {
          type: "url_citation",
          title: "Anthropic News",
          url: "https://anthropic.com/news",
          citedText: "Anthropic launched web search..."
        }
      ]
    };

    render(<ChatMessage msg={msg} messageIndex={0} sessionId="test_session" />);

    // Web search bubble
    expect(screen.getByText("联网搜索")).toBeTruthy();
    expect(screen.getByText("✓ search: Claude web search release date")).toBeTruthy();

    // Content
    expect(screen.getByText("Here is the information found.")).toBeTruthy();

    // Citations bubble
    expect(screen.getByText("参考来源")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Anthropic News/i });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://anthropic.com/news");
  });

  it("preserves native search cards alongside ordinary tools after user input", () => {
    const { rerender } = render(<ChatMessageList messages={buildSearchToolMessages(1)} />);

    expect(screen.getByText("✓ search: native search regression")).toBeTruthy();
    expect(screen.getByText("Continuing research.")).toBeTruthy();
    expect(screen.getByText(/tab_list/)).toBeTruthy();
    expect(screen.queryByText(/request_user_input/)).toBeNull();

    rerender(<ChatMessageList messages={buildSearchToolMessages(5)} />);

    expect(screen.getAllByText("联网搜索")).toHaveLength(1);
    expect(screen.getByText("✓ search: native search regression")).toBeTruthy();
  });

  it("keeps search cards visible when later tools collapse into a long group", () => {
    const { rerender } = render(<ChatMessageList messages={buildSearchToolMessages(5)} />);

    rerender(<ChatMessageList messages={buildSearchToolMessages(6)} />);

    expect(screen.getByText("展开查看 6 个工具调用详情")).toBeTruthy();
    expect(screen.getByText("✓ search: native search regression")).toBeTruthy();
    expect(screen.queryByText("Continuing research.")).toBeNull();

    fireEvent.click(screen.getByText("展开查看 6 个工具调用详情"));
    expect(screen.getAllByText("联网搜索")).toHaveLength(1);
    expect(screen.getByText("Continuing research.")).toBeTruthy();

    rerender(<ChatMessageList messages={buildSearchToolMessages(7)} />);
    expect(screen.getByText("展开查看 7 个工具调用详情")).toBeTruthy();
    expect(screen.getAllByText("联网搜索")).toHaveLength(1);
    expect(screen.getByText("Continuing research.")).toBeTruthy();
  });

  it("preserves search cards on assistant tool messages without text", () => {
    const messages = buildSearchToolMessages(1);
    messages[2] = { ...messages[2], content: null };

    render(<ChatMessageList messages={messages} />);

    expect(screen.getByText("✓ search: native search regression")).toBeTruthy();
    expect(screen.getByText(/tab_list/)).toBeTruthy();
  });

  it("retains a search-only final message when its thinking joins a collapsed group", () => {
    render(
      <ChatMessageList messages={[
        ...buildSearchToolMessages(6),
        {
          role: "assistant",
          content: null,
          reasoning: "Research is complete.",
          web_searches: [{ type: "search", query: "final search regression" }]
        }
      ]} />
    );

    expect(screen.getByText("展开查看 6 个工具调用详情")).toBeTruthy();
    expect(screen.getByText("✓ search: native search regression")).toBeTruthy();
    expect(screen.getByText("✓ search: final search regression")).toBeTruthy();
  });

  it("filters out empty thinking block even when signature exists", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "WaU..." },
        { type: "text", text: "Hello, how can I help you?" }
      ]
    };

    render(<ChatMessage msg={msg} messageIndex={0} sessionId="test_session" />);

    expect(screen.queryByText(/💭/)).toBeNull();
    expect(screen.getByText("Hello, how can I help you?")).toBeTruthy();
  });

  it("merges multiple consecutive text blocks into a single bubble", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello, " },
        { type: "text", text: "world! " },
        { type: "text", text: "How are you?" }
      ]
    };

    const { container } = render(<ChatMessage msg={msg} messageIndex={0} sessionId="test_session" />);

    // Check that there is only one assistant bubble
    const bubbles = container.querySelectorAll(".chat-bubble-assistant");
    expect(bubbles.length).toBe(1);
    expect(screen.getByText("Hello, world! How are you?")).toBeTruthy();
  });
});
