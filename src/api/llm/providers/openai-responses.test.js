import { describe, expect, it } from "vitest";
import {
  buildResponsesRequestInput,
  extractResponsesEncryptedReasoningDelta,
  extractResponsesReasoningDelta,
  extractResponsesReasoningText,
  normalizeResponsesReasoningInputItem
} from "./openai-responses";

describe("OpenAI responses reasoning helpers", () => {
  it("extracts streamed reasoning deltas", () => {
    expect(extractResponsesReasoningDelta({
      type: "response.reasoning_summary_text.delta",
      delta: "summary chunk"
    })).toBe("summary chunk");

    expect(extractResponsesReasoningDelta({
      type: "response.output_text.delta",
      delta: "assistant text"
    })).toBe("");
  });

  it("keeps encrypted reasoning separate from display reasoning", () => {
    expect(extractResponsesEncryptedReasoningDelta({
      type: "response.reasoning.encrypted_content.delta",
      delta: "encrypted chunk"
    })).toBe("encrypted chunk");

    expect(extractResponsesReasoningDelta({
      type: "response.reasoning.encrypted_content.delta",
      delta: "encrypted chunk"
    })).toBe("");
  });

  it("extracts final reasoning output items", () => {
    expect(extractResponsesReasoningText({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "final summary" }]
    })).toBe("final summary");
  });

  it("normalizes encrypted reasoning items for replay", () => {
    expect(normalizeResponsesReasoningInputItem({
      id: "rs_123",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "summary" }],
      encrypted_content: "ciphertext",
      order: 0
    })).toEqual({
      id: "rs_123",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "summary" }],
      encrypted_content: "ciphertext"
    });
  });

  it("drops output-only status from reasoning replay items", () => {
    expect(normalizeResponsesReasoningInputItem({
      id: "rs_123",
      type: "reasoning",
      status: "completed",
      summary: [],
      encrypted_content: "ciphertext"
    })).toEqual({
      id: "rs_123",
      type: "reasoning",
      summary: [],
      encrypted_content: "ciphertext"
    });
  });

  it("strips output-only status from final responses request input", () => {
    const result = buildResponsesRequestInput([
      {
        role: "assistant",
        content: "I will call a tool.",
        _responsesReasoningItems: [
          {
            id: "rs_123",
            type: "reasoning",
            status: "completed",
            summary: [],
            encrypted_content: "ciphertext"
          }
        ],
        tool_calls: [
          {
            id: "call_123",
            status: "completed",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" }
          }
        ]
      }
    ]);

    expect(JSON.stringify(result.input)).not.toContain("\"status\"");
    expect(result.input).toEqual([
      { id: "rs_123", type: "reasoning", summary: [], encrypted_content: "ciphertext" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will call a tool." }] },
      { type: "function_call", id: "fc_call_123", call_id: "call_123", name: "lookup", arguments: "{\"query\":\"x\"}" }
    ]);
  });

  it("keeps required empty summary on encrypted-only reasoning replay", () => {
    expect(normalizeResponsesReasoningInputItem({
      id: "rs_123",
      type: "reasoning",
      encrypted_content: "ciphertext"
    })).toEqual({
      id: "rs_123",
      type: "reasoning",
      summary: [],
      encrypted_content: "ciphertext"
    });
  });

  it("replays stored responses reasoning items before assistant output", () => {
    expect(buildResponsesRequestInput([
      {
        role: "assistant",
        content: "I will call a tool.",
        _responsesReasoningItems: [
          { id: "rs_123", type: "reasoning", encrypted_content: "ciphertext" }
        ],
        tool_calls: [
          {
            id: "call_123",
            response_item_id: "fc_123",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" }
          }
        ]
      }
    ]).input).toEqual([
      { id: "rs_123", type: "reasoning", summary: [], encrypted_content: "ciphertext" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will call a tool." }] },
      { type: "function_call", id: "fc_123", call_id: "call_123", name: "lookup", arguments: "{\"query\":\"x\"}" }
    ]);
  });

  it("generates a responses function call item id for chat tool calls", () => {
    expect(buildResponsesRequestInput([
      {
        role: "assistant",
        content: "I will call a tool.",
        tool_calls: [
          {
            id: "call_123",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" }
          }
        ]
      }
    ]).input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will call a tool." }] },
      { type: "function_call", id: "fc_call_123", call_id: "call_123", name: "lookup", arguments: "{\"query\":\"x\"}" }
    ]);
  });

  it("omits stored reasoning items when thinking replay is disabled", () => {
    expect(buildResponsesRequestInput([
      {
        role: "assistant",
        content: "I will call a tool.",
        _responsesReasoningItems: [
          { id: "rs_123", type: "reasoning", encrypted_content: "ciphertext" }
        ],
        tool_calls: [
          {
            id: "call_123",
            response_item_id: "fc_123",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" }
          }
        ]
      }
    ], { omitThinkingFromRequests: true }).input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will call a tool." }] },
      { type: "function_call", id: "fc_123", call_id: "call_123", name: "lookup", arguments: "{\"query\":\"x\"}" }
    ]);
  });

  it("builds structured image function call outputs when image input is enabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify({ success: true, imageRefs: ["img_1", "img_2"] }),
        displayImages: [
          { url: "data:image/png;base64,aGVsbG8=" },
          { url: "data:image/png;base64,d29ybGQ=" }
        ]
      }
    ], { supportsImageInput: true });

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: [
          { type: "input_text", text: "{\"success\":true,\"imageRefs\":[\"img_1\",\"img_2\"]}" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "low" },
          { type: "input_image", image_url: "data:image/png;base64,d29ybGQ=", detail: "low" }
        ]
      }
    ]);
  });

  it("keeps image function call outputs textual when image input is disabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "done",
        displayImages: [{ url: "data:image/png;base64,aGVsbG8=" }]
      }
    ], { supportsImageInput: false });

    expect(result.input).toEqual([
      { type: "function_call_output", call_id: "call_123", output: "done" }
    ]);
  });

  it("sends hydrated user image blocks as responses input images", () => {
    const result = buildResponsesRequestInput([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "dXNlcg==",
              ref: "img_1"
            }
          }
        ]
      }
    ]);

    expect(result.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,dXNlcg==" }
        ]
      }
    ]);
  });

  it("omits responses user image blocks only when image input is explicitly disabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "dXNlcg==" }
          }
        ]
      }
    ], { supportsImageInput: false });

    expect(result.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "look" }]
      }
    ]);
  });

  it("does not send unhydrated session image placeholders as responses input images", () => {
    const result = buildResponsesRequestInput([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "session_image", ref: "img_1", media_type: "image/png" }
          }
        ]
      }
    ]);

    expect(result.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "look" }]
      }
    ]);
  });

  it("keeps user image support while omitting display images when tool image input is disabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "done",
        displayImages: [{ url: "data:image/png;base64,aGVsbG8=" }]
      }
    ], { supportsImageInput: true, supportsToolImageInput: false });

    expect(result.input).toEqual([
      { type: "function_call_output", call_id: "call_123", output: "done" }
    ]);
  });

  it("keeps regular JSON tool output textual", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify({
          success: true,
          dataUrl: "data:image/png;base64,aGVsbG8=",
          images: [
            { dataUrl: "data:image/jpeg;base64,d29ybGQ=", width: 100 }
          ]
        })
      }
    ]);

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "{\"success\":true,\"dataUrl\":\"data:image/png;base64,aGVsbG8=\",\"images\":[{\"dataUrl\":\"data:image/jpeg;base64,d29ybGQ=\",\"width\":100}]}"
      }
    ]);
  });

  it("parses JSON stringified tool content blocks into structured responses output", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify([
          { type: "text", text: "Tool result for tab_screenshot: {\"success\":true}" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }
        ])
      }
    ], { supportsImageInput: true });

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: [
          { type: "input_text", text: "Tool result for tab_screenshot: {\"success\":true}" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "low" }
        ]
      }
    ]);
  });

  it("omits structured image blocks when image input is disabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify([
          { type: "text", text: "done" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }
        ])
      }
    ], { supportsImageInput: false });

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "done\n[omitted image from previous tool output]"
      }
    ]);
  });

  it("sends hydrated tool result image refs as structured responses output images", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "done",
        displayImages: [{ url: "data:image/png;base64,dG9vbA==", ref: "img_2" }]
      }
    ], { supportsImageInput: true, supportsToolImageInput: true });

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: [
          { type: "input_text", text: "done" },
          { type: "input_image", image_url: "data:image/png;base64,dG9vbA==", detail: "low" }
        ]
      }
    ]);
  });

  it("does not send unhydrated tool result image refs as structured responses output images", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "done",
        displayImages: [{ url: "session-image:img_2", ref: "img_2" }]
      }
    ], { supportsImageInput: true, supportsToolImageInput: true });

    expect(result.input).toEqual([
      { type: "function_call_output", call_id: "call_123", output: "done" }
    ]);
  });

  it("keeps hydrated tool result image refs out when responses tool image input is disabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "done",
        displayImages: [{ url: "data:image/png;base64,dG9vbA==", ref: "img_2" }]
      }
    ], { supportsImageInput: true, supportsToolImageInput: false });

    expect(result.input).toEqual([
      { type: "function_call_output", call_id: "call_123", output: "done" }
    ]);
  });

  it("omits structured image blocks when only tool image input is disabled", () => {
    const result = buildResponsesRequestInput([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify([
          { type: "text", text: "done" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }
        ])
      }
    ], { supportsImageInput: true, supportsToolImageInput: false });

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "done\n[omitted image from previous tool output]"
      }
    ]);
  });
});
