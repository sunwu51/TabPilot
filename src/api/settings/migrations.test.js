import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSettingsMigrated,
  migrateModelProfilesV2,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY
} from "./migrations";

const getChrome = () => globalThis.chrome;

describe("settings migrations", () => {
  beforeEach(() => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(),
          set: vi.fn()
        }
      }
    };
  });

  it("moves legacy model fields into profile arrays and removes old keys", async () => {
    getChrome().storage.local.get.mockResolvedValueOnce({
      [SETTINGS_SCHEMA_VERSION_KEY]: 1,
      llmConfig: {
        apiType: "anthropic",
        baseUrl: "https://api.example/messages",
        apiKey: "llm-token",
        model: "claude-test",
        imageBaseUrl: "https://api.example/v1",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "image-test"
      }
    });

    const result = await ensureSettingsMigrated();

    expect(result).toEqual({ migrated: true, version: SETTINGS_SCHEMA_VERSION });
    const setCall = getChrome().storage.local.set.mock.calls[0][0];
    expect(setCall[SETTINGS_SCHEMA_VERSION_KEY]).toEqual(SETTINGS_SCHEMA_VERSION);
    expect(setCall.llmConfig).toEqual(
      expect.objectContaining({
        activeLlmModelId: "llm_legacy",
        llmModels: [
          expect.objectContaining({
            id: "llm_opencode_zen_big_pickle",
            name: "OpenCode Zen Big Pickle",
            apiType: "openai-chat-completions",
            baseUrl: "https://opencode.ai/zen/v1/chat/completions",
            apiKey: "",
            model: "big-pickle",
            requiresApiKey: false
          }),
          expect.objectContaining({
            id: "llm_legacy",
            name: "claude-test",
            apiType: "anthropic",
            baseUrl: "https://api.example/messages",
            apiKey: "llm-token",
            model: "claude-test"
          })
        ],
        modelContextLimitTokens: 200000,
        firstPacketTimeoutSeconds: 20,
        supportsImageInput: false,
        supportsToolImageInput: false,
        reasoningEffort: "default",
        omitThinkingFromRequests: false,
        activeImageModelId: expect.stringMatching(/^img_image_test_[a-f0-9]{6}$/),
        imageModels: [
          expect.objectContaining({
            id: expect.stringMatching(/^img_image_test_[a-f0-9]{6}$/),
            name: "image-test",
            imageBaseUrl: "https://api.example/v1",
            imageApiKey: "img-token",
            imageApiProtocol: "chat_completions",
            imageModel: "image-test"
          })
        ]
      })
    );
  });

  it("keeps explicitly cleared image profiles empty during migration", () => {
    expect(migrateModelProfilesV2({
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "https://api.example/v1",
      imageApiKey: "img-token",
      imageModel: "image-test"
    })).toMatchObject({
      activeLlmModelId: "llm_opencode_zen_big_pickle",
      llmModels: [
        expect.objectContaining({
          id: "llm_opencode_zen_big_pickle",
          model: "big-pickle",
          requiresApiKey: false
        })
      ],
      activeImageModelId: "",
      imageModels: []
    });
  });
});
