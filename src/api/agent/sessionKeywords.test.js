import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot, resetChromeMock } from "../../../test/setup";

const { textComplete, getLLMConfigForMemory } = vi.hoisted(() => ({
  textComplete: vi.fn(),
  getLLMConfigForMemory: vi.fn()
}));

vi.mock("../llm/providers/textComplete", () => ({
  textComplete,
  getLLMConfigForMemory
}));

import { refreshSessionKeywords } from "./sessionKeywords";

const messages = [
  { role: "user", content: "请帮我排查浏览器扩展中历史会话关键词刷新过于频繁的问题，并给出可以验证的修复方案。".repeat(2) },
  { role: "assistant", content: "我会检查定时器、请求失败处理和关键词响应格式，然后补上回归测试。".repeat(2) }
];

describe("session keywords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChromeMock({ sessions_index: [{ id: "a", title: "A", updatedAt: 1 }] });
    getLLMConfigForMemory.mockResolvedValue({ apiType: "openai", baseUrl: "https://example.test", model: "test" });
  });

  it("backs off after malformed keyword output instead of retrying every refresh", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    textComplete.mockResolvedValue("关键词：扩展调试、定时刷新");

    const first = await refreshSessionKeywords("a", messages);
    const second = await refreshSessionKeywords("a", messages);

    expect(first.reason).toBe("invalid_keyword_format");
    expect(second.reason).toBe("retry_cooldown");
    expect(textComplete).toHaveBeenCalledTimes(1);
    expect(getLLMConfigForMemory).toHaveBeenCalledWith({ keywordSummary: true });
    expect(getChromeStorageSnapshot().sessions_index[0]).toMatchObject({
      keywordRetryMessageIndex: 1,
      keywordLastError: "invalid_keyword_format"
    });
  });

  it("retries immediately when new conversation content arrives", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    textComplete.mockResolvedValueOnce("not json").mockResolvedValueOnce('["扩展调试","关键词刷新"]');
    await refreshSessionKeywords("a", messages);

    const result = await refreshSessionKeywords("a", [...messages, { role: "user", content: "请确保新的消息会立即重新触发关键词更新。".repeat(2) }]);

    expect(result).toMatchObject({ updated: true, keywords: ["扩展调试", "关键词刷新"], keywordMessageIndex: 2 });
    expect(textComplete).toHaveBeenCalledTimes(2);
    expect(getChromeStorageSnapshot().sessions_index[0]).not.toHaveProperty("keywordRetryAfter");
  });
});
