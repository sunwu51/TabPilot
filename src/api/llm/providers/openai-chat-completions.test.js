import { describe, expect, it } from "vitest";
import { extractOpenAIReasoningDeltas } from "./openai-chat-completions";
import { buildOpenAIChatReasoningFields } from "../core/reasoning";

describe("OpenAI chat completions reasoning helpers", () => {
  it("sets both chat completions reasoning effort fields", () => {
    expect(buildOpenAIChatReasoningFields({ reasoningEffort: "high" })).toEqual({
      reasoning_effort: "high",
      reasoning: { effort: "high" }
    });
  });

  it("omits reasoning fields when the selected profile disables reasoning", () => {
    expect(buildOpenAIChatReasoningFields({
      reasoningEffort: "medium",
      supportsReasoning: false
    })).toEqual({});
  });

  it("extracts reasoning from compatible delta fields", () => {
    expect(extractOpenAIReasoningDeltas({ reasoning: "step 1" })).toEqual({ reasoning: "step 1" });
    expect(extractOpenAIReasoningDeltas({ reasoning_content: "step 2" })).toEqual({ reasoning_content: "step 2" });
    expect(extractOpenAIReasoningDeltas({ thinking: { text: "step 3" } })).toEqual({ thinking: "step 3" });
  });
});
