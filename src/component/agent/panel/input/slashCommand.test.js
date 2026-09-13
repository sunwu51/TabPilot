import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  buildMemoryCommandPrompt,
  buildRecallMemoryCommandPrompt,
  filterSlashCommands,
  shouldBlockSlashCommand
} from "./slashCommand";

describe("memory slash command prompts", () => {
  it("exposes manual context compaction", () => {
    expect(SLASH_COMMANDS).toContainEqual(expect.objectContaining({ id: "compact", name: "/compact" }));
  });

  it("localizes built-in command labels before filtering", () => {
    const commands = filterSlashCommands(SLASH_COMMANDS, [], [], "/comp", key => ({
      slashCompactTitle: "Compact context",
      slashCompactDescription: "Summarize older history"
    })[key] || key);

    expect(commands).toEqual([
      expect.objectContaining({ name: "/compact", title: "Compact context", description: "Summarize older history" })
    ]);
  });

  it("blocks slash-like input while commands are unavailable", () => {
    expect(shouldBlockSlashCommand("/comp", true)).toBe(true);
    expect(shouldBlockSlashCommand("normal message", true)).toBe(false);
    expect(shouldBlockSlashCommand("/comp", false)).toBe(false);
  });

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
