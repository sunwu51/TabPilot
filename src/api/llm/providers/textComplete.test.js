import { describe, expect, it, vi } from "vitest";
import { textComplete } from "./textComplete";

describe("textComplete", () => {
  it("extracts OpenAI chat completion text from output_text blocks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: [
              { type: "output_text", text: "前端调试" },
              { type: "output_text", text: "、报错排查" }
            ]
          }
        }]
      })
    })));

    await expect(textComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }]
    )).resolves.toBe("前端调试、报错排查");

    vi.unstubAllGlobals();
  });

  it("allows empty OpenAI chat completion responses when requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: [
              { type: "reasoning", text: "internal thought only" }
            ]
          }
        }]
      })
    })));

    await expect(textComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }],
      { allowEmptyResponse: true }
    )).resolves.toBe("");

    vi.unstubAllGlobals();
  });
});
