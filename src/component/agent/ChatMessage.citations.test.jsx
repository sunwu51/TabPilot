/* global chrome */
/* eslint-disable react/prop-types */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, ...props }) => <button type="button" onClick={onPress} {...props}>{children}</button>,
  Dialog: ({ children, trigger }) => <div>{trigger}{children}</div>
}));

import ChatMessage from "./ChatMessage";

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
