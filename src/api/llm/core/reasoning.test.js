import { describe, expect, it } from "vitest";
import {
  buildAnthropicReasoningFields,
  buildOpenAIChatReasoningFields,
  buildOpenAIResponsesReasoningFields,
  isCustomReasoningEffort,
  normalizeReasoningEffort,
  normalizeStoredReasoningEffort
} from "./reasoning";

describe("reasoning effort helpers", () => {
  it("keeps presets, max and custom provider values in stored config", () => {
    expect(normalizeStoredReasoningEffort("xhigh")).toBe("xhigh");
    expect(normalizeStoredReasoningEffort("max")).toBe("max");
    expect(normalizeStoredReasoningEffort("  minimal ")).toBe("minimal");
    expect(normalizeStoredReasoningEffort("")).toBe("default");
    expect(normalizeStoredReasoningEffort(undefined)).toBe("default");
    expect(normalizeStoredReasoningEffort("a".repeat(100))).toHaveLength(64);
  });

  it("detects custom values", () => {
    expect(isCustomReasoningEffort("max")).toBe(false);
    expect(isCustomReasoningEffort("default")).toBe(false);
    expect(isCustomReasoningEffort("minimal")).toBe(true);
  });

  it("omits reasoning fields for default and passes other values through", () => {
    expect(normalizeReasoningEffort("default")).toBe("");
    expect(buildOpenAIChatReasoningFields({ reasoningEffort: "default" })).toEqual({});
    expect(buildOpenAIChatReasoningFields({ reasoningEffort: "max" })).toEqual({ reasoning_effort: "max", reasoning: { effort: "max" } });
    expect(buildOpenAIResponsesReasoningFields({ reasoningEffort: "none" })).toEqual({ reasoning: { effort: "none" } });
    expect(buildAnthropicReasoningFields({ reasoningEffort: "max" })).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" }
    });
  });
});
