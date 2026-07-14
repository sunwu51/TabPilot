import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID,
  buildLlmAuthHeaders,
  isLlmConfigUsable,
  normalizeImageModelProfiles,
  normalizeLlmModelProfiles,
  resolveActiveImageConfig,
  resolveActiveLlmConfig,
  syncActiveModelFields
} from "./modelProfiles";
import { isImageApiConfigured } from "../tools/builtins/imageApi";

describe("modelProfiles", () => {
  it("provides the OpenCode Zen Big Pickle LLM profile by default", () => {
    const normalized = normalizeLlmModelProfiles({ llmModels: [] });

    expect(normalized).toMatchObject({
      activeId: DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID,
      activeProfile: {
        id: DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID,
        name: "OpenCode Zen Big Pickle",
        apiType: "openai-chat-completions",
        baseUrl: "https://opencode.ai/zen/v1/chat/completions",
        apiKey: "",
        model: "big-pickle",
        requiresApiKey: false
      }
    });
    expect(resolveActiveLlmConfig({ llmModels: [] })).toMatchObject({
      activeLlmModelId: DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID,
      baseUrl: "https://opencode.ai/zen/v1/chat/completions",
      apiKey: "",
      model: "big-pickle",
      requiresApiKey: false
    });
    expect(isLlmConfigUsable({ llmModels: [] })).toBe(true);
  });

  it("keeps the built-in OpenCode Zen model first when custom profiles exist", () => {
    const normalized = normalizeLlmModelProfiles({
      activeLlmModelId: "llm_custom",
      llmModels: [
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

    expect(normalized.profiles.map(item => item.id)).toEqual([
      DEFAULT_OPENCODE_ZEN_FREE_LLM_MODEL_ID,
      "llm_custom"
    ]);
    expect(normalized.activeId).toBe("llm_custom");
  });

  it("omits authorization headers when an LLM profile has no API key", () => {
    expect(buildLlmAuthHeaders({
      baseUrl: "https://opencode.ai/zen/v1/chat/completions",
      model: "big-pickle",
      apiKey: "",
      requiresApiKey: false
    })).toEqual({});
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
