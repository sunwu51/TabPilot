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
});
