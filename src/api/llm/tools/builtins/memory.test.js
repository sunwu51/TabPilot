import { describe, expect, it, vi } from "vitest";
import { chromeStorageVfs } from "../../../../utils/chromeStorageVfs";
import {
  MEMORY_INDEX_PATH,
  MEMORY_SEARCH_MIN_SCORE,
  _execMemoryDelete,
  _execMemorySave,
  _execMemorySearch,
  _execMemoryUpdate,
  scoreMemory
} from "./memory";

const openCodeMemory = {
  id: "mem_opencode",
  type: "decision",
  subject: "TabManager 免费模型提供商",
  summary: "移除不稳定的 OpenCode 免费入口，关键词总结改用当前聊天模型",
  content: "OpenCode 免费接口出现 HTTP 429，因此移除该入口。",
  keywords: ["OpenCode", "免费模型", "429", "Big Pickle", "关键词总结"],
  entities: ["TabManager", "OpenCode"],
  scope: { kind: "project", value: "TabManager" },
  importance: 0.9
};

const chromeMemory = {
  id: "mem_chrome",
  type: "reference",
  subject: "Chrome 内置免费模型",
  summary: "Chrome Built-in AI 需要在本地下载 Gemini Nano 模型",
  content: "Chrome 可使用本地 Gemini Nano。",
  keywords: ["Chrome", "内置模型", "Gemini Nano", "LanguageModel"],
  entities: ["Chrome", "Gemini Nano"],
  scope: { kind: "topic", value: "Chrome Built-in AI" },
  importance: 0.6
};

describe("built-in long-term memory", () => {
  it("scores distinctive entity and keyword matches above generic n-gram overlap", () => {
    const query = "OpenCode 免费模型 429 最终处理决定";
    const relevant = scoreMemory(openCodeMemory, query);
    const generic = scoreMemory(chromeMemory, query);

    expect(relevant.score).toBeGreaterThan(MEMORY_SEARCH_MIN_SCORE);
    expect(relevant.signals.matchedEntities).toEqual(["OpenCode"]);
    expect(relevant.signals.matchedKeywords).toEqual(["免费模型", "429"]);
    expect(relevant.signals.distinctiveBonus).toBe(5);
    expect(generic.score).toBeLessThan(MEMORY_SEARCH_MIN_SCORE);
    expect(generic.signals.weakMatchPenalty).toBe(0.35);
  });

  it("creates and upserts by scope, type, and stable subject", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValueOnce(100);
    const created = await _execMemorySave(openCodeMemory);
    const updated = await _execMemorySave({
      ...openCodeMemory,
      summary: "关键词总结默认使用当前聊天模型",
      content: "移除 OpenCode 免费入口，使用当前聊天模型。"
    });

    expect(created).toMatchObject({ success: true, action: "created" });
    expect(updated).toMatchObject({ success: true, action: "updated" });
    expect(updated.memory.id).toBe(created.memory.id);
    expect(updated.memory.confirmationCount).toBe(2);
    const stored = await chromeStorageVfs.readJson(MEMORY_INDEX_PATH);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].summary).toBe("关键词总结默认使用当前聊天模型");
  });

  it("searches above the fixed minimum, filters, updates, and deletes by id", async () => {
    const first = await _execMemorySave(openCodeMemory);
    await _execMemorySave(chromeMemory);

    const result = await _execMemorySearch({ query: "OpenCode 免费模型 429 最终处理决定" });
    expect(result).toMatchObject({ success: true, minScore: 6, count: 1 });
    expect(result.memories[0]).toMatchObject({ id: first.memory.id, subject: openCodeMemory.subject });
    expect(result.memories[0].score).toBeGreaterThanOrEqual(6);

    const filtered = await _execMemorySearch({
      query: "OpenCode 免费模型 429",
      type: "preference"
    });
    expect(filtered.count).toBe(0);

    await expect(_execMemoryUpdate({ id: first.memory.id, importance: 1, summary: "修正后的总结" }))
      .resolves.toMatchObject({ success: true, memory: { summary: "修正后的总结", importance: 1 } });
    await expect(_execMemoryDelete({ id: first.memory.id })).resolves.toMatchObject({ removed: true });
    await expect(_execMemoryDelete({ id: first.memory.id })).resolves.toMatchObject({ existed: false });
  });

  it("rejects invalid writes and never permits a lower search threshold", async () => {
    await expect(_execMemorySave({ type: "temporary", subject: "x", summary: "x", content: "x" }))
      .rejects.toThrow("Unsupported memory type");
    await _execMemorySave(openCodeMemory);
    const result = await _execMemorySearch({ query: "unrelated", minScore: 0 });
    expect(result.minScore).toBe(MEMORY_SEARCH_MIN_SCORE);
    expect(result.count).toBe(0);
  });
});
