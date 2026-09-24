import { describe, expect, it, vi } from "vitest";
import { streamAnthropicAttempt } from "./anthropic";

function createStreamResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    })
  };
}

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("streamAnthropicAttempt", () => {
  it("ignores OpenAI-style DONE markers in Anthropic SSE streams", async () => {
    const fetchMock = vi.fn(async () => createStreamResponse([
      "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"前端\"}}\n\n",
      "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"调试\"}}\n\n",
      "data: [DONE]\n\n"
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const onDone = vi.fn();

    await expect(streamAnthropicAttempt(
      { apiType: "anthropic", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "claude-test" },
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
      { onDone }
    )).resolves.toBeUndefined();

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      content: expect.any(Array)
    }));

    vi.unstubAllGlobals();
  });

  it("defaults max_tokens to 32000", async () => {
    const fetchMock = vi.fn(async () => createStreamResponse([
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } }),
      sse({ type: "content_block_stop", index: 0 })
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await streamAnthropicAttempt(
      { apiType: "anthropic", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "claude-test" },
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
      { onDone: vi.fn() }
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.max_tokens).toBe(32000);

    vi.unstubAllGlobals();
  });

  it("reports max_tokens truncation when a tool_use block is cut off", async () => {
    const fetchMock = vi.fn(async () => createStreamResponse([
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "exec", input: {} } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }),
      sse({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } }),
      sse({ type: "message_stop" })
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamAnthropicAttempt(
      { apiType: "anthropic", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "claude-test" },
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
      { onDone: vi.fn() }
    )).rejects.toMatchObject({ code: "MAX_TOKENS_TRUNCATED" });

    vi.unstubAllGlobals();
  });
});
