import { describe, expect, it } from "vitest";
import { API_TYPES } from "../../../../api/llm";
import { buildApiMessages } from "./buildApiMessages";

describe("buildApiMessages image options", () => {
  const toolImageMessage = {
    role: "tool",
    tool_call_id: "call_1",
    tool_name: "image_gen",
    content: JSON.stringify({ success: true }),
    displayImages: [{ url: "data:image/png;base64,aGVsbG8=" }]
  };

  it("keeps user images while omitting OpenAI tool result images when disabled", () => {
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlcg==" } }
        ]
      },
      toolImageMessage
    ], {
      supportsImageInput: true,
      supportsToolImageInput: false
    });

    expect(result[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,dXNlcg==", detail: "low" }
    });
    expect(result[1].content).toBe(JSON.stringify({ success: true }));
  });

  it("keeps user images while omitting Anthropic tool result images when disabled", () => {
    const result = buildApiMessages(API_TYPES.ANTHROPIC, [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlcg==" } }
        ]
      },
      toolImageMessage
    ], {
      supportsImageInput: true,
      supportsToolImageInput: false
    });

    expect(result[0].content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "dXNlcg==" }
    });
    expect(result[1].content[0].content).toBe(JSON.stringify({ success: true }));
  });

  it("does not send unhydrated session-image placeholders to OpenAI", () => {
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "session_image", ref: "img_1", media_type: "image/png" } }
      ]
    }], {
      supportsImageInput: true
    });

    expect(result).toEqual([{
      role: "user",
      content: [{ type: "text", text: "look" }]
    }]);
  });

  it("does not send unhydrated session-image placeholders to Anthropic", () => {
    const result = buildApiMessages(API_TYPES.ANTHROPIC, [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "session_image", ref: "img_1", media_type: "image/png" } }
      ]
    }], {
      supportsImageInput: true
    });

    expect(result).toEqual([{
      role: "user",
      content: [{ type: "text", text: "look" }]
    }]);
  });
});
