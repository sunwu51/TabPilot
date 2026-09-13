import { describe, expect, it } from "vitest";
import { buildMemoryCommandPrompt, buildRecallMemoryCommandPrompt } from "./slashCommand";

describe("memory slash command prompts", () => {
  it("routes /mem to the built-in upsert tool", () => {
    const prompt = buildMemoryCommandPrompt();

    expect(prompt).toContain("内置 memory_save");
    expect(prompt).toContain("scope、type 和稳定的 subject");
    expect(prompt).not.toContain("MCP");
  });

  it("routes /recall_mem to built-in scored search", () => {
    const prompt = buildRecallMemoryCommandPrompt();

    expect(prompt).toContain("内置 memory_search");
    expect(prompt).toContain("不要只使用“上次”或“之前”");
    expect(prompt).not.toContain("MCP");
  });
});
