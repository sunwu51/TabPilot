import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: () => null,
  Card: () => null,
  Dialog: () => null
}));

import {
  buildSessionExportMarkdown,
  collectToolResultDisplayImages
} from "./AgentPanel";

describe("AgentPanel session export", () => {
  it("does not render ordinary tool result URLs as images", () => {
    expect(collectToolResultDisplayImages({
      id: 123,
      title: "OpenAI API docs",
      url: "https://developers.openai.com/api/reference/overview"
    })).toEqual([]);
  });

  it("keeps explicit image URLs renderable", () => {
    expect(collectToolResultDisplayImages({
      imageUrl: "https://example.com/output.png"
    })).toEqual([
      {
        url: "https://example.com/output.png",
        mediaType: undefined,
        kind: "url"
      }
    ]);
  });

  it("replaces assistant markdown deRef image sources with base64 data URLs", () => {
    const markdown = buildSessionExportMarkdown({
      title: "图片会话",
      sessionId: "session_1",
      messages: [
        {
          role: "tool",
          imageRefs: [
            { ref: "img_2", dataUrl: "data:image/png;base64,aGVsbG8=" }
          ],
          content: "{}"
        },
        {
          role: "assistant",
          content: "![Codex vs Claude Code](|deRef:img_2|)"
        }
      ]
    });

    expect(markdown).toContain("![Codex vs Claude Code](data:image/png;base64,aGVsbG8=)");
    expect(markdown).not.toContain("|deRef:img_2|");
  });

  it("can omit base64 images for lightweight share markdown", () => {
    const markdown = buildSessionExportMarkdown({
      title: "图片会话",
      sessionId: "session_1",
      includeImages: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "请看图片" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" }
            }
          ]
        },
        {
          role: "tool",
          imageRefs: [
            { ref: "img_2", dataUrl: "data:image/png;base64,aGVsbG8=" }
          ],
          displayImages: [
            { url: "data:image/png;base64,d29ybGQ=", mediaType: "image/png" }
          ],
          content: "{}"
        },
        {
          role: "assistant",
          content: "![输出图](|deRef:img_2|)"
        }
      ]
    });

    expect(markdown).toContain("[用户图片已省略 · image/png]");
    expect(markdown).toContain("![输出图](about:blank \"img_2 图片已省略\")");
    expect(markdown).toContain("[工具图片已省略 · 1 张]");
    expect(markdown).not.toContain("data:image/png;base64");
    expect(markdown).not.toContain("|deRef:img_2|");
  });
});
