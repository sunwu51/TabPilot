import { describe, expect, it, vi } from "vitest";
import { buildDisplayToolResultMessage } from "./toolResults";

describe("code-mode image tool results", () => {
  it("keeps exec image artifacts visual while omitting base64 from text content", () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const registerImageDataUrl = vi.fn(() => "img_4");

    const message = buildDisplayToolResultMessage({
      id: "call_exec",
      name: "exec",
      result: {
        status: "completed",
        value: { success: true, dataUrl: "|deRef:img_4|" },
        images: [{ ref: "img_4", dataUrl, mediaType: "image/png" }]
      }
    }, "session_1", registerImageDataUrl);

    expect(message.displayImageUrl).toBe(dataUrl);
    expect(message.imageRefs).toEqual([
      { ref: "img_4", dataUrl, mediaType: "image/png", role: "tool_result" }
    ]);
    expect(message.content).toContain("|deRef:img_4|");
    expect(message.content).toContain('"imageRefs":["img_4"]');
    expect(message.content).not.toContain(dataUrl);
  });
});
