import { describe, expect, it } from "vitest";
import {
  buildLlmAuthHeaders,
  isLlmConfigUsable,
  normalizeImageModelProfiles,
  normalizeLlmModelProfiles,
  resolveActiveImageConfig,
  resolveActiveLlmConfig,
  resolveKeywordSummaryLlmConfig,
  syncActiveModelFields
} from "./modelProfiles";
import { isImageApiConfigured } from "../tools/builtins/imageApi";

describe("modelProfiles", () => {
  it("has no built-in LLM profile when nothing is configured", () => {
    const normalized = normalizeLlmModelProfiles({ llmModels: [] });

    expect(normalized).toEqual({ profiles: [], activeId: "", activeProfile: null });
    expect(isLlmConfigUsable({ llmModels: [] })).toBe(false);
  });

  it("keeps supportsReasoning=false from a profile", () => {
    expect(resolveActiveLlmConfig({
      llmModels: [{ id: "llm_a", baseUrl: "https://api.example.com/v1", apiKey: "sk", model: "m", supportsReasoning: false }],
      reasoningEffort: "medium"
    })).toMatchObject({
      supportsReasoning: false,
      reasoningEffort: "medium"
    });
  });

  it("removes retired built-in profiles and falls back to the first configured model", () => {
    const normalized = normalizeLlmModelProfiles({
      activeLlmModelId: "llm_llm7_default",
      llmModels: [
        { id: "llm_opencode_zen_big_pickle", model: "big-pickle", baseUrl: "https://opencode.ai/zen/v1/chat/completions" },
        { id: "llm_llm7_default", model: "default", baseUrl: "https://api.llm7.io", requiresApiKey: false },
        {
          id: "llm_custom",
          name: "Custom",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          model: "custom-model"
        }
      ]
    });

    expect(normalized.profiles.map(item => item.id)).toEqual(["llm_custom"]);
    expect(normalized.activeId).toBe("llm_custom");
  });

  it("uses the active model for keyword summaries until explicitly overridden", () => {
    const config = {
      activeLlmModelId: "llm_custom",
      llmModels: [
        { id: "llm_custom", name: "Custom", apiType: "openai-chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "custom-model" },
        { id: "llm_summary", name: "Summary", apiType: "openai-chat-completions", baseUrl: "https://summary.example.com/v1", apiKey: "sk-summary", model: "summary-model" }
      ]
    };

    expect(resolveKeywordSummaryLlmConfig(config)).toMatchObject({
      keywordSummaryModelId: "llm_custom",
      model: "custom-model"
    });
    expect(resolveKeywordSummaryLlmConfig({ ...config, keywordSummaryUseCustomModel: true, keywordSummaryModelId: "llm_summary" })).toMatchObject({
      keywordSummaryModelId: "llm_summary",
      model: "summary-model"
    });
  });

  it("omits authorization headers when an LLM profile has no API key", () => {
    expect(buildLlmAuthHeaders({
      baseUrl: "http://localhost:11434/v1/chat/completions",
      model: "local-model",
      apiKey: "",
      requiresApiKey: false
    })).toEqual({});
  });

  it("keeps OpenAI Subscription identity fields without requiring a URL or API key", () => {
    const config = {
      activeLlmModelId: "llm_subscription",
      llmModels: [{
        id: "llm_subscription",
        name: "OpenAI Subscription",
        apiType: "openai-subscription",
        model: "gpt-5-codex",
        credentialId: "llm_subscription",
        accountId: "account-123",
        email: "user@example.com",
        planType: "plus",
        requiresApiKey: false
      }]
    };

    expect(resolveActiveLlmConfig(config)).toMatchObject({
      apiType: "openai-subscription",
      baseUrl: "",
      apiKey: "",
      credentialId: "llm_subscription",
      accountId: "account-123",
      nativeWebSearch: true
    });
    expect(isLlmConfigUsable(config)).toBe(true);
  });

  it("keeps explicitly cleared image model profiles empty", () => {
    const config = {
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "https://api.example.com/v1",
      imageApiKey: "old-token",
      imageModel: "gpt-image-2"
    };

    expect(normalizeImageModelProfiles(config)).toMatchObject({
      profiles: [],
      activeId: "",
      activeProfile: null
    });
    expect(resolveActiveImageConfig(config)).toMatchObject({
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "",
      imageApiKey: "",
      imageModel: "",
      selectedImageProfile: null
    });
    expect(syncActiveModelFields(config)).toMatchObject({
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "",
      imageApiKey: "",
      imageModel: ""
    });
    expect(isImageApiConfigured(config)).toBe(false);
  });

  it("does not migrate legacy image fields at runtime", () => {
    const config = {
      imageBaseUrl: "https://api.example.com/v1",
      imageApiKey: "old-token",
      imageModel: "legacy-image-model"
    };

    expect(normalizeImageModelProfiles(config).profiles).toEqual([]);
    expect(isImageApiConfigured(config)).toBe(false);
  });
});
