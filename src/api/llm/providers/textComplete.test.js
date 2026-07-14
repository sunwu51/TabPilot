import { describe, expect, it, vi } from "vitest";
import { streamTextComplete, textComplete } from "./textComplete";

describe("textComplete", () => {
  it("extracts OpenAI chat completion text from output_text blocks", async () => {
    const fetchMock = vi.fn(async () => ({
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
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(textComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }]
    )).resolves.toBe("前端调试、报错排查");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1",
      expect.objectContaining({
        body: expect.stringContaining("\"enable_thinking\":false")
      })
    );

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

  it("passes enable_thinking false to OpenAI chat completions requests", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: "done"
          }
        }]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await textComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }]
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ enable_thinking: false });

    vi.unstubAllGlobals();
  });

  it("omits Authorization when OpenAI-compatible config does not require an API key", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "done" } }]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await textComplete(
      {
        apiType: "openai-chat-completions",
        baseUrl: "https://opencode.ai/zen/v1/chat/completions",
        apiKey: "",
        model: "big-pickle",
        requiresApiKey: false
      },
      [{ role: "user", content: "hello" }]
    );

    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json"
    });

    vi.unstubAllGlobals();
  });

  it("passes custom maxTokens to OpenAI chat completion requests", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "done" } }]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await textComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }],
      { maxTokens: 2048 }
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ max_tokens: 2048 });

    vi.unstubAllGlobals();
  });

  it("streams text completion chunks without exposing tools", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: stream
    }));
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [];
    const { promise } = streamTextComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }],
      { onText: (chunk) => chunks.push(chunk) },
      { maxTokens: 1800 }
    );

    await expect(promise).resolves.toBe("hello world");
    expect(chunks).toEqual(["hello", " world"]);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ max_tokens: 1800, stream: true });
    expect(payload.tools).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("streams OpenAI-compatible text without Authorization when API key is not required", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: stream
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { promise } = streamTextComplete(
      {
        apiType: "openai-chat-completions",
        baseUrl: "https://opencode.ai/zen/v1/chat/completions",
        apiKey: "",
        model: "big-pickle",
        requiresApiKey: false
      },
      [{ role: "user", content: "hello" }]
    );

    await expect(promise).resolves.toBe("hello");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json"
    });

    vi.unstubAllGlobals();
  });

  it("stops streaming text completion when maxChars is exceeded", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(80) } }] })}\n\n`));
      }
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: stream
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { promise } = streamTextComplete(
      { apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-test" },
      [{ role: "user", content: "hello" }],
      {},
      { maxChars: 32 }
    );

    const result = await promise;
    expect(result).toContain("输出已按长度上限截断");
    expect(result.length).toBeLessThanOrEqual(32);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);

    vi.unstubAllGlobals();
  });
});
