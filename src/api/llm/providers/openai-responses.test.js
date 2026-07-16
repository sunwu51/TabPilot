import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildResponsesRequestInput,
  extractResponsesEncryptedReasoningDelta,
  extractResponsesReasoningDelta,
  extractResponsesReasoningText,
  normalizeResponsesReasoningInputItem,
  extractResponsesCitations,
  applyResponsesUrlCitations,
  buildResponsesDisplayText,
  dedupeResponsesOutputTextParts,
  streamOpenAIResponsesAttempt
} from "./openai-responses";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI responses reasoning helpers", () => {
  it("deduplicates identical output text and keeps annotations", () => {
    const annotation = { type: "url_citation", title: "Title", url: "https://example.com", start_index: 0, end_index: 4 };
    expect(dedupeResponsesOutputTextParts([
      { type: "output_text", text: "same text", annotations: [] },
      { type: "output_text", text: "same text", annotations: [annotation] },
      { type: "input_text", text: "trace" }
    ])).toEqual([
      { type: "output_text", text: "same text", annotations: [annotation] },
      { type: "input_text", text: "trace" }
    ]);
  });

  it("replaces leaked citation markers with clickable annotation links", () => {
    const marker = "citeturn1search1";
    const text = `OpenAI released an update ${marker}.`;
    const start = text.indexOf(marker);
    expect(applyResponsesUrlCitations(text, [{
      type: "url_citation",
      start_index: start,
      end_index: start + marker.length,
      title: "OpenAI update",
      url: "https://openai.com/news"
    }])).toBe("OpenAI released an update [OpenAI update](https://openai.com/news).");
  });

  it("uses annotation title instead of the cited domain text for offset citations", () => {
    const text = "Source: arstechnica.com";
    const start = text.indexOf("arstechnica.com");
    expect(applyResponsesUrlCitations(text, [{
      type: "url_citation",
      start_index: start,
      end_index: start + "arstechnica.com".length,
      title: "Ars Technica - Serving the Technologist since 1998",
      url: "https://arstechnica.com/"
    }])).toBe(
      "Source: [Ars Technica - Serving the Technologist since 1998](https://arstechnica.com/)"
    );
  });

  it("replaces an existing domain markdown link label with the annotation title", () => {
    const citation = "[techcrunch.com](https://techcrunch.com/2026/07/)";
    const text = `News (${citation})`;
    const start = text.indexOf(citation);
    expect(applyResponsesUrlCitations(text, [{
      type: "url_citation",
      start_index: start,
      end_index: start + citation.length,
      title: "July 2026 | TechCrunch",
      url: "https://techcrunch.com/2026/07/?utm_source=openai"
    }])).toBe(
      "News ([July 2026 | TechCrunch](https://techcrunch.com/2026/07/?utm_source=openai))"
    );
  });

  it("removes leaked private-use citation markers without annotations", () => {
    expect(buildResponsesDisplayText([{
      type: "output_text",
      text: "Result citeturn1search1 text",
      annotations: []
    }])).toBe("Result  text");
  });

  it("replaces complete and partially leaked citation markers before using offsets", () => {
    expect(applyResponsesUrlCitations(
      "A citeturn1search1 B cite[turn1search2 C [citeturn1search3]",
      [
        { type: "url_citation", title: "One", url: "https://one.test" },
        { type: "url_citation", title: "Two", url: "https://two.test" },
        { type: "url_citation", title: "Three", url: "https://three.test" }
      ]
    )).toBe("A [One](https://one.test) B [Two](https://two.test) C [Three](https://three.test)");
  });

  it("replaces bare search and news citation tokens, including adjacent tokens", () => {
    expect(applyResponsesUrlCitations(
      "A turn1search8 B turn1news12turn1search7 C",
      [
        { type: "url_citation", title: "Search 8", url: "https://search8.test" },
        { type: "url_citation", title: "News 12", url: "https://news12.test" },
        { type: "url_citation", title: "Search 7", url: "https://search7.test" }
      ]
    )).toBe(
      "A [Search 8](https://search8.test) B [News 12](https://news12.test)[Search 7](https://search7.test) C"
    );
  });

  it("reuses an annotation when the same citation token appears again", () => {
    expect(applyResponsesUrlCitations(
      "Body turn1search1 and turn1search2. References: turn1search1, turn1search2.",
      [
        { type: "url_citation", title: "One", url: "https://one.test" },
        { type: "url_citation", title: "Two", url: "https://two.test" }
      ]
    )).toBe(
      "Body [One](https://one.test) and [Two](https://two.test). References: [One](https://one.test), [Two](https://two.test)."
    );
  });

  it("uses the reference list title as link text instead of the annotation domain", () => {
    expect(applyResponsesUrlCitations(
      "参考内容：\n- TechCrunch 2026年7月科技新闻汇总： (turn1search1)\n- 东方财富早间新闻精选：turn1search2",
      [
        { type: "url_citation", title: "techcrunch.com", url: "https://techcrunch.com/2026/07/" },
        { type: "url_citation", title: "finance.eastmoney.com", url: "https://finance.eastmoney.com/news" }
      ]
    )).toBe(
      "参考内容：\n- [TechCrunch 2026年7月科技新闻汇总](https://techcrunch.com/2026/07/)\n- [东方财富早间新闻精选](https://finance.eastmoney.com/news)"
    );
  });

  it("extracts and deduplicates URL citations from the final message", () => {
    expect(extractResponsesCitations([
      {
        type: "output_text",
        text: "A",
        annotations: [{ type: "url_citation", title: "Source A", url: "https://a.test", start_index: 0, end_index: 1 }]
      },
      {
        type: "output_text",
        text: "B",
        annotations: [
          { type: "url_citation", title: "Source A", url: "https://a.test" },
          { type: "url_citation", title: "Source B", url: "https://b.test" }
        ]
      }
    ])).toEqual([
      { type: "url_citation", title: "Source A", url: "https://a.test", startIndex: 0, endIndex: 1 },
      { type: "url_citation", title: "Source B", url: "https://b.test", startIndex: undefined, endIndex: undefined }
    ]);
  });

  it("replays native web search call items when web search remains enabled", () => {
    expect(buildResponsesRequestInput([
      {
        role: "assistant",
        content: "Search summary",
        web_search_items: [{
          id: "ws_123",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "latest news" }
        }],
        web_searches: [{ type: "search", query: "latest news" }]
      }
    ], { nativeWebSearch: true }).input).toEqual([
      {
        type: "web_search_call",
        id: "ws_123",
        status: "completed",
        action: { type: "search", query: "latest news" }
      },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Search summary" },
          { type: "input_text", text: "\n\n[Previous web search actions]\n1.1. search: latest news" }
        ]
      }
    ]);
  });

  it("keeps the original interleaved reasoning and web search order", () => {
    const replayItems = [
      { id: "rs_1", type: "reasoning", summary: [] },
      { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "one" } },
      { id: "rs_2", type: "reasoning", summary: [] },
      { id: "ws_2", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com" } }
    ];
    const input = buildResponsesRequestInput([{
      role: "assistant",
      content: "Summary",
      _responsesReplayItems: replayItems
    }], { nativeWebSearch: true }).input;

    expect(input.slice(0, 4)).toEqual(replayItems);
  });

  it("includes stored web search call items in the real streamed request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await streamOpenAIResponsesAttempt({
      apiType: "openai-responses",
      baseUrl: "https://api.openai.test/v1/responses",
      apiKey: "test-key",
      model: "gpt-test",
      nativeWebSearch: true
    }, [{
      role: "assistant",
      content: "Search summary",
      web_search_items: [{
        id: "ws_123",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "latest news" }
      }]
    }], new AbortController().signal, {}, [], { includeBuiltins: false });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input[0]).toEqual({
      id: "ws_123",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "latest news" }
    });
    expect(body.tools[0]).toEqual({ type: "web_search" });
  });

  it("preserves completed response annotations and renders their links", async () => {
    const marker = "citeturn1search1";
    const text = `Result ${marker}`;
    const start = text.indexOf(marker);
    const event = {
      type: "response.completed",
      response: {
        id: "resp_annotated",
        output: [{
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text,
            annotations: [{
              type: "url_citation",
              start_index: start,
              end_index: start + marker.length,
              title: "Source",
              url: "https://example.com/source"
            }]
          }]
        }]
      }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `data: ${JSON.stringify(event)}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    )));
    const onDone = vi.fn();

    await streamOpenAIResponsesAttempt({
      baseUrl: "https://api.openai.test/v1/responses",
      apiKey: "test-key",
      model: "gpt-test"
    }, [], new AbortController().signal, { onDone }, [], { includeBuiltins: false });

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      content: "Result [Source](https://example.com/source)",
      citations: [expect.objectContaining({ url: "https://example.com/source" })],
      response_content: [expect.objectContaining({
        annotations: [expect.objectContaining({ url: "https://example.com/source" })]
      })]
    }));
  });

  it("collects streamed annotation events when completed output omits annotations", async () => {
    const marker = "citeturn1search1";
    const text = `Result ${marker}`;
    const start = text.indexOf(marker);
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_stream", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_stream", content_index: 0, delta: text },
      {
        type: "response.output_text.annotation.added",
        output_index: 0,
        item_id: "msg_stream",
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: "url_citation",
          start_index: start,
          end_index: start + marker.length,
          title: "Stream source",
          url: "https://example.com/stream"
        }
      },
      { type: "response.output_text.done", output_index: 0, item_id: "msg_stream", content_index: 0, text },
      { type: "response.completed", response: { id: "resp_stream", output: [] } }
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    )));
    const onDone = vi.fn();

    await streamOpenAIResponsesAttempt({
      baseUrl: "https://api.openai.test/v1/responses",
      apiKey: "test-key",
      model: "gpt-test"
    }, [], new AbortController().signal, { onDone }, [], { includeBuiltins: false });

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      content: "Result [Stream source](https://example.com/stream)",
      response_content: [expect.objectContaining({
        annotations: [expect.objectContaining({ url: "https://example.com/stream" })]
      })]
    }));
  });

  it("does not duplicate message text when streamed events omit item_id", async () => {
    const text = "A response that should appear once.";
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_once", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: text },
      { type: "response.output_text.done", output_index: 0, text },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_once", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_once", output: [] } }
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    )));
    const onDone = vi.fn();

    await streamOpenAIResponsesAttempt({
      baseUrl: "https://api.openai.test/v1/responses",
      apiKey: "test-key",
      model: "gpt-test"
    }, [], new AbortController().signal, { onDone }, [], { includeBuiltins: false });

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ content: text }));
    expect(onDone.mock.calls[0][0].response_content).toHaveLength(1);
  });

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
