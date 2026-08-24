import { describe, expect, it } from "vitest";
import {
  buildContextSummaryPrompt,
  buildContextSummaryRequestMessages,
  buildMergedContextSummary,
  CONTEXT_SUMMARY_MAX_CHARS,
  CONTEXT_SUMMARY_MAX_OUTPUT_TOKENS,
  CONTEXT_SUMMARY_MAX_TOOL_ARGUMENT_CHARS,
  CONTEXT_SUMMARY_MAX_TOOL_RESULT_CHARS,
  findContextSummaryCutIndex,
  formatMessagesForSummary,
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
  it("builds a concise summary prompt with a bounded output budget", () => {
    const prompt = buildContextSummaryPrompt({
      oldSummary: "old",
      messages: makeMessages(2)
    });

    expect(CONTEXT_SUMMARY_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(700);
    expect(prompt).toContain("总长度不超过 900 个中文字符");
    expect(prompt).toContain("不逐条复述工具调用");
    expect(prompt).toContain("固定格式");
  });

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
      displayMessageIndex: 9,
      model: "model-a"
    })).toEqual(expect.objectContaining({
      version: 1,
      coveredMessageIndex: 7,
      displayMessageIndex: 9,
      summary: "merged",
      createdAt: existing.createdAt,
      sourceModel: "model-a"
    }));
  });

  it("falls back divider display index to the covered index for old summaries", () => {
    expect(normalizeContextSummary({
      version: 1,
      coveredMessageIndex: 4.8,
      summary: "existing"
    })).toEqual(expect.objectContaining({
      coveredMessageIndex: 4,
      displayMessageIndex: 4
    }));
  });

  it("bounds stored summary text even if the provider ignores max output tokens", () => {
    const normalized = normalizeContextSummary({
      version: 1,
      coveredMessageIndex: 1,
      summary: "x".repeat(CONTEXT_SUMMARY_MAX_CHARS + 100)
    });

    expect(normalized.summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS);
    expect(normalized.summary).toContain("摘要已按长度上限截断");
  });

  it("trims long tool arguments and results only in the compaction transcript", () => {
    const longArguments = "a".repeat(CONTEXT_SUMMARY_MAX_TOOL_ARGUMENT_CHARS + 200);
    const longResult = "z".repeat(CONTEXT_SUMMARY_MAX_TOOL_RESULT_CHARS + 200);
    const messages = [
      { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "exec", arguments: longArguments } }] },
      { role: "tool", tool_call_id: "call_1", tool_name: "exec", content: longResult }
    ];

    const transcript = formatMessagesForSummary(messages);

    expect(transcript).toContain("工具参数已截断");
    expect(transcript).toContain("工具结果已截断");
    expect(transcript).toContain(`原始长度 ${longArguments.length + 2} 字符`);
    expect(messages[0].tool_calls[0].function.arguments).toBe(longArguments);
    expect(messages[1].content).toBe(longResult);
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

  it("compacts a completed, oversized recent tool round instead of retaining it wholesale", () => {
    const messages = [
      ...makeMessages(40),
      { role: "assistant", content: "calling", tool_calls: [{ id: "call_1", function: { name: "tab_extract", arguments: "{}" } }] },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "tool",
        tool_call_id: `call_${index + 1}`,
        tool_name: "tab_extract",
        content: "x".repeat(3000)
      })),
      { role: "user", content: "继续处理" }
    ];
    const defaultCutIndex = findContextSummaryCutIndex(messages);
    const adaptiveCutIndex = findContextSummaryCutIndex(messages, { limitTokens: 10_000 });

    expect(adaptiveCutIndex).toBeGreaterThan(defaultCutIndex);
    expect(adaptiveCutIndex).toBe(messages.length - 2);
    expect(shouldAutoCompactContext({
      contextUsage: { tokens: 7_300 },
      limitTokens: 10_000,
      messages,
      contextSummary: { version: 1, coveredMessageIndex: defaultCutIndex, summary: "old summary" }
    })).toBe(true);
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
