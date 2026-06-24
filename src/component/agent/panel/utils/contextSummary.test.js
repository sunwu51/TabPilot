import { describe, expect, it } from "vitest";
import {
  buildContextSummaryRequestMessages,
  buildMergedContextSummary,
  findContextSummaryCutIndex,
  getKeepLastMessagesForContextSummary,
  getMessagesToSummarize,
  normalizeContextSummary,
  shouldAutoCompactContext
} from "./contextSummary";

function makeMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`
  }));
}

describe("contextSummary helpers", () => {
  it("builds request messages from summary plus uncovered history", () => {
    const messages = makeMessages(5);
    const result = buildContextSummaryRequestMessages({
      contextSummary: {
        version: 1,
        coveredMessageIndex: 2,
        summary: "old context",
        createdAt: 1
      },
      messages
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      role: "user",
      content: expect.stringContaining("old context")
    });
    expect(result.slice(1)).toEqual(messages.slice(3));
  });

  it("summarizes only new messages after the existing covered index", () => {
    const messages = makeMessages(10);
    const existing = normalizeContextSummary({
      version: 1,
      coveredMessageIndex: 3,
      summary: "existing"
    });

    expect(getMessagesToSummarize(messages, existing, 7)).toEqual(messages.slice(4, 8));
    expect(buildMergedContextSummary({
      previousSummary: existing,
      newSummary: "merged",
      coveredMessageIndex: 7,
      model: "model-a"
    })).toEqual(expect.objectContaining({
      version: 1,
      coveredMessageIndex: 7,
      summary: "merged",
      createdAt: existing.createdAt,
      sourceModel: "model-a"
    }));
  });

  it("moves the cut to the end of a completed tool sequence", () => {
    const messages = [
      ...makeMessages(6),
      { role: "assistant", content: "calling", tool_calls: [{ id: "call_1", function: { name: "tab_list", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", tool_name: "tab_list", content: "{\"ok\":true}" },
      ...makeMessages(4)
    ];

    expect(findContextSummaryCutIndex(messages, { keepLastMessages: 5 })).toBe(7);
  });

  it("does not compact into a pending tool sequence", () => {
    const messages = [
      ...makeMessages(6),
      { role: "assistant", content: "calling", tool_calls: [{ id: "call_1", function: { name: "tab_list", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", tool_name: "tab_list", content: null, _pending: true },
      ...makeMessages(4)
    ];

    expect(findContextSummaryCutIndex(messages, { keepLastMessages: 5 })).toBe(5);
  });

  it("triggers compaction when usage passes the configured ratio", () => {
    const messages = makeMessages(40);
    expect(shouldAutoCompactContext({
      contextUsage: { tokens: 730 },
      limitTokens: 1000,
      messages,
      contextSummary: null
    })).toBe(true);
  });

  it("can compact short conversations with very large messages", () => {
    const messages = makeMessages(5);

    expect(getKeepLastMessagesForContextSummary(messages.length)).toBe(2);
    expect(findContextSummaryCutIndex(messages)).toBe(2);
    expect(shouldAutoCompactContext({
      contextUsage: { tokens: 163000 },
      limitTokens: 200000,
      messages,
      contextSummary: null
    })).toBe(true);
  });

  it("skips compaction when the existing summary already covers the safe cut", () => {
    const messages = makeMessages(40);
    const cutIndex = findContextSummaryCutIndex(messages);
    expect(shouldAutoCompactContext({
      contextUsage: { tokens: 950 },
      limitTokens: 1000,
      messages,
      contextSummary: { version: 1, coveredMessageIndex: cutIndex, summary: "done" }
    })).toBe(false);
  });
});
