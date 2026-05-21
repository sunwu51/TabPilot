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

  it("strips local-only image ref fields from Anthropic user image blocks", () => {
    const result = buildApiMessages(API_TYPES.ANTHROPIC, [{
      role: "user",
      content: [
        {
          type: "image",
          ref: "img_7",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "dXNlcg==",
            ref: "img_7"
          }
        }
      ]
    }], {
      supportsImageInput: true
    });

    expect(result).toEqual([{
      role: "user",
      content: [{
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "dXNlcg=="
        }
      }]
    }]);
  });

  it("strips local-only image ref fields from OpenAI user image blocks", () => {
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [{
      role: "user",
      content: [
        {
          type: "image",
          ref: "img_7",
          displayImageRef: "img_7",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "dXNlcg==",
            ref: "img_7"
          }
        }
      ]
    }], {
      supportsImageInput: true
    });

    expect(result).toEqual([{
      role: "user",
      content: [{
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,dXNlcg==",
          detail: "low"
        }
      }]
    }]);
  });

  it("normalizes Anthropic user content blocks instead of forwarding local-only fields", () => {
    const result = buildApiMessages(API_TYPES.ANTHROPIC, [{
      role: "user",
      content: [
        { type: "text", text: "hello", imageRefs: ["img_1"], displayImages: [{ url: "x" }] },
        { type: "file", fileName: "note.txt", text: "file body", imageEditMeta: { kind: "edit" } }
      ],
      imageRefs: [{ ref: "img_1", dataUrl: "data:image/png;base64,dXNlcg==" }]
    }], {
      supportsImageInput: true
    });

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "[Attached file: note.txt]\nfile body" }
      ]
    }]);
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

  it("strips local-only image edit metadata from provider requests", () => {
    const messages = [{
      role: "user",
      content: "edit this image",
      imageRefs: [{ ref: "img_1", dataUrl: "data:image/png;base64,dXNlcg==" }],
      imageEditMeta: {
        kind: "image_edit",
        hasMask: true,
        referenceCount: 2
      }
    }];

    expect(buildApiMessages(API_TYPES.OPENAI_CHAT, messages)).toEqual([{
      role: "user",
      content: "edit this image"
    }]);

    expect(buildApiMessages(API_TYPES.ANTHROPIC, messages)).toEqual([{
      role: "user",
      content: "edit this image"
    }]);
  });

  it("strips provider-specific tool call metadata from OpenAI chat requests", () => {
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        response_item_id: "fc_1",
        function: {
          name: "lookup",
          arguments: "{\"query\":\"x\"}"
        },
        displayImages: [{ url: "data:image/png;base64,aGVsbG8=" }]
      }]
    }]);

    expect(result).toEqual([{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "lookup",
          arguments: "{\"query\":\"x\"}"
        }
      }]
    }]);
  });
});
