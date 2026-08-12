import { describe, expect, it } from "vitest";
import {
  chatRequestToProvider,
  providerResponseToChat
} from "./nanollm-protocol-converter.js";

const chatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "Click the button" }],
  tools: [{
    type: "function",
    function: {
      name: "click_button",
      description: "Click a page button.",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] }
    }
  }],
  tool_choice: "required",
  stream: false
};

describe("nanollm protocol converter vendor", () => {
  it("converts Page Agent chat requests to Responses and Anthropic requests", () => {
    const responses = chatRequestToProvider(chatRequest, "openai-responses");
    const anthropic = chatRequestToProvider(chatRequest, "anthropic");

    expect(responses).toMatchObject({ model: "test-model", tool_choice: "required" });
    expect(responses.input).toHaveLength(1);
    expect(responses.tools[0]).toMatchObject({ type: "function", name: "click_button" });
    expect(anthropic).toMatchObject({ model: "test-model", tool_choice: { type: "any" } });
    expect(anthropic.tools[0]).toMatchObject({ name: "click_button" });
  });

  it("converts provider tool calls back to Chat Completions while preserving IDs", () => {
    const responses = providerResponseToChat({
      id: "resp_1",
      created_at: 1,
      model: "test-model",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_response_1", name: "click_button", arguments: '{"selector":"#go"}' }]
    }, "openai-responses");
    const anthropic = providerResponseToChat({
      id: "msg_1",
      model: "test-model",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_1", name: "click_button", input: { selector: "#go" } }]
    }, "anthropic");

    expect(responses.choices[0]).toMatchObject({ finish_reason: "tool_calls" });
    expect(responses.choices[0].message.tool_calls[0]).toMatchObject({ id: "call_response_1", function: { name: "click_button", arguments: '{"selector":"#go"}' } });
    expect(anthropic.choices[0]).toMatchObject({ finish_reason: "tool_calls" });
    expect(anthropic.choices[0].message.tool_calls[0]).toMatchObject({ id: "toolu_1", function: { name: "click_button", arguments: '{"selector":"#go"}' } });
  });
});
