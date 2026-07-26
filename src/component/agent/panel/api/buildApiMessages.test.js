import { describe, expect, it } from "vitest";
import { API_TYPES } from "../../../../api/llm";
import { buildApiMessages } from "./buildApiMessages";
import { buildResponsesRequestInput } from "../../../../api/llm/providers/openai-responses";

describe("buildApiMessages image options", () => {
  const toolImageMessage = {
    role: "tool",
    tool_call_id: "call_1",
    tool_name: "image_gen",
    content: JSON.stringify({ success: true }),
    displayImages: [{ url: "data:image/png;base64,aGVsbG8=" }]
  };
  const userImageMessage = {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlcg==" } }
    ]
  };

  it("adds uploaded image URLs as text without replacing vision content", () => {
    const message = {
      ...userImageMessage,
      imageRefs: [{
        ref: "img_1",
        dataUrl: "data:image/png;base64,dXNlcg==",
        uploadedUrl: "https://project.supabase.co/storage/v1/object/public/images/session/s_1/img_1.png"
      }]
    };
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT_COMPLETIONS, [message], { supportsImageInput: true });
    expect(result[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url" }),
      {
        type: "text",
        text: "This image has been uploaded to URL: https://project.supabase.co/storage/v1/object/public/images/session/s_1/img_1.png"
      }
    ]));
  });

  it("keeps the uploaded URL in the final Responses input_text", () => {
    const uploadedUrl = "https://project.supabase.co/storage/v1/object/public/tabmanager/images/s_1/img_1_x.jpg";
    const apiMessages = buildApiMessages(API_TYPES.OPENAI_RESPONSES, [{
      ...userImageMessage,
      imageRefs: [{ ref: "img_1", dataUrl: "data:image/png;base64,dXNlcg==", uploadedUrl }]
    }], { supportsImageInput: true });
    const request = buildResponsesRequestInput(apiMessages, { supportsImageInput: true });
    expect(request.input[0].content).toEqual(expect.arrayContaining([
      { type: "input_text", text: `This image has been uploaded to URL: ${uploadedUrl}` },
      expect.objectContaining({ type: "input_image" })
    ]));
  });

  it("preserves Responses web search items when native search remains enabled", () => {
    const history = [{
      role: "assistant",
      content: "Search summary",
      web_search_items: [{
        id: "ws_123",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "latest news" }
      }],
      web_searches: [{ type: "search", query: "latest news" }]
    }];

    const apiMessages = buildApiMessages(API_TYPES.OPENAI_RESPONSES, history, {
      nativeWebSearch: true,
      omitThinkingFromRequests: true
    });
    expect(apiMessages[0]).toMatchObject({
      web_search_items: history[0].web_search_items,
      web_searches: history[0].web_searches
    });
    expect(buildResponsesRequestInput(apiMessages, { nativeWebSearch: true }).input[0]).toEqual(history[0].web_search_items[0]);
  });

  it("preserves Responses output text annotations in the next request", () => {
    const annotation = {
      type: "url_citation",
      start_index: 7,
      end_index: 12,
      title: "Source",
      url: "https://example.com/source"
    };
    const apiMessages = buildApiMessages(API_TYPES.OPENAI_RESPONSES, [{
      role: "assistant",
      content: "Result source",
      _responsesContent: [{ type: "output_text", text: "Result source", annotations: [annotation] }]
    }], { nativeWebSearch: true });

    const request = buildResponsesRequestInput(apiMessages, { nativeWebSearch: true });
    expect(request.input[0].content[0]).toEqual({
      type: "output_text",
      text: "Result source",
      annotations: [annotation]
    });
  });

  it("keeps OpenAI Chat user images by default", () => {
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [userImageMessage]);

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,dXNlcg==", detail: "low" }
        }
      ]
    }]);
  });

  it("keeps Anthropic user images by default", () => {
    const result = buildApiMessages(API_TYPES.ANTHROPIC, [userImageMessage]);

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "dXNlcg==" }
        }
      ]
    }]);
  });

  it("omits user images only when image input is explicitly disabled", () => {
    expect(buildApiMessages(API_TYPES.OPENAI_CHAT, [userImageMessage], {
      supportsImageInput: false
    })).toEqual([{
      role: "user",
      content: [{ type: "text", text: "look" }]
    }]);

    expect(buildApiMessages(API_TYPES.ANTHROPIC, [userImageMessage], {
      supportsImageInput: false
    })).toEqual([{
      role: "user",
      content: [{ type: "text", text: "look" }]
    }]);
  });

  it("sends OpenAI Chat tool result images through a follow-up user message", () => {
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "image_gen",
            arguments: "{\"prompt\":\"cat\"}"
          }
        }]
      },
      toolImageMessage
    ], {
      supportsImageInput: true,
      supportsToolImageInput: true
    });

    expect(result).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "image_gen",
            arguments: "{\"prompt\":\"cat\"}"
          }
        }]
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify({ success: true })
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The following image is from the previous image_gen tool result."
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" }
          }
        ]
      }
    ]);
  });

  it("parses large OpenAI Chat tool result image data URLs without regex stack pressure", () => {
    const imageData = "a".repeat(512 * 1024);
    const dataUrl = `data:image/png;base64,${imageData}`;
    const result = buildApiMessages(API_TYPES.OPENAI_CHAT, [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "image_gen",
            arguments: "{\"prompt\":\"cat\"}"
          }
        }]
      },
      {
        ...toolImageMessage,
        displayImages: [{ url: dataUrl }]
      }
    ], {
      supportsImageInput: true,
      supportsToolImageInput: true
    });

    expect(result[2].content[1]).toEqual({
      type: "image_url",
      image_url: { url: dataUrl, detail: "low" }
    });
  });

  it("keeps OpenAI Responses tool result images on the function output item", () => {
    const apiMessages = buildApiMessages(API_TYPES.OPENAI_RESPONSES, [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "image_gen",
            arguments: "{\"prompt\":\"cat\"}"
          }
        }]
      },
      toolImageMessage
    ], {
      supportsImageInput: true,
      supportsToolImageInput: true
    });

    expect(apiMessages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "image_gen",
            arguments: "{\"prompt\":\"cat\"}"
          }
        }]
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify({ success: true }),
        displayImages: [{ url: "data:image/png;base64,aGVsbG8=" }]
      }
    ]);

    expect(buildResponsesRequestInput(apiMessages, {
      supportsImageInput: true,
      supportsToolImageInput: true
    }).input).toEqual([
      {
        type: "function_call",
        id: "fc_call_1",
        call_id: "call_1",
        name: "image_gen",
        arguments: "{\"prompt\":\"cat\"}"
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "{\"success\":true}" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "low" }
        ]
      }
    ]);
  });

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
