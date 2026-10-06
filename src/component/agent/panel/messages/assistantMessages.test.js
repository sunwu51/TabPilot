import { describe, expect, it } from "vitest";
import { API_TYPES } from "../../../../api/llm";
import { buildFinalAssistantMessage, buildAssistantToolCallMessage } from "./assistantMessages";

describe("assistantMessages", () => {
  it("attaches citations and web_searches to Anthropic final message", () => {
    const doneMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Answer with source" }],
      citations: [{ type: "url_citation", title: "Source Title", url: "https://example.com" }],
      web_searches: [{ type: "search", query: "example query" }],
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    const finalMsg = buildFinalAssistantMessage(API_TYPES.ANTHROPIC, "claude-test", null, doneMsg);

    expect(finalMsg).toEqual(expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "Answer with source" }],
      citations: [{ type: "url_citation", title: "Source Title", url: "https://example.com" }],
      web_searches: [{ type: "search", query: "example query" }]
    }));
  });

  it("attaches citations and web_searches to Anthropic tool call message", () => {
    const doneMsg = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "tool", input: {} }],
      citations: [{ type: "url_citation", title: "Source Title", url: "https://example.com" }],
      web_searches: [{ type: "search", query: "example query" }],
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    const toolMsg = buildAssistantToolCallMessage(API_TYPES.ANTHROPIC, "claude-test", null, doneMsg);

    expect(toolMsg).toEqual(expect.objectContaining({
      role: "assistant",
      citations: [{ type: "url_citation", title: "Source Title", url: "https://example.com" }],
      web_searches: [{ type: "search", query: "example query" }]
    }));
  });
});
