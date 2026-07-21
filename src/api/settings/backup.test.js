import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_BACKUP_KEYS,
  exportSettingsBackup,
  importSettingsBackupFromText
} from "./backup";
import {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY
} from "./migrations";

const getChrome = () => globalThis.chrome;

describe("settings backup", () => {
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

  it("exports only whitelisted settings after storage migration", async () => {
    getChrome().storage.local.get
      .mockResolvedValueOnce({
        [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION,
        llmConfig: {}
      })
      .mockResolvedValueOnce({
        llmConfig: {
          activeLlmModelId: "llm_a",
          llmModels: [{ id: "llm_a", model: "gpt-test", baseUrl: "https://api.example/v1", apiKey: "secret" }]
        },
        reuse: true,
        mcpServers: [{ url: "https://example.com" }]
      });

    const backup = await exportSettingsBackup();

    expect(getChrome().storage.local.get).toHaveBeenNthCalledWith(2, SETTINGS_BACKUP_KEYS);
    expect(backup.settings).toEqual({
      llmConfig: {
        activeLlmModelId: "llm_a",
        llmModels: [{ id: "llm_a", model: "gpt-test", baseUrl: "https://api.example/v1", apiKey: "secret" }]
      },
      reuse: true
    });
  });

  it("imports legacy singleton model config as the new profile schema", async () => {
    getChrome().storage.local.get
      .mockResolvedValueOnce({
        [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION,
        llmConfig: {}
      })
      .mockResolvedValueOnce({
        llmConfig: {
          modelContextLimitTokens: 400000,
          firstPacketTimeoutSeconds: 30
        }
      });

    const result = await importSettingsBackupFromText(JSON.stringify({
      settings: {
        llmConfig: {
          apiType: "anthropic",
          baseUrl: "https://api.example/messages",
          apiKey: "old",
          model: "old-model",
          imageBaseUrl: "https://api.openai.com/v1",
          imageApiKey: "img-secret",
          imageApiProtocol: "chat_completions",
          imageModel: "gpt-image-2",
          supportsImageInput: true,
          supportsToolImageInput: true
        },
        mcpServers: [{ url: "ignored" }]
      }
    }));

    expect(result.updatedKeys).toEqual(["llmConfig", SETTINGS_SCHEMA_VERSION_KEY]);
    expect(getChrome().storage.local.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        llmConfig: expect.objectContaining({
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
              name: "old-model",
              apiType: "anthropic",
              baseUrl: "https://api.example/messages",
              apiKey: "old",
              model: "old-model"
            })
          ],
          modelContextLimitTokens: 400000,
          firstPacketTimeoutSeconds: 30,
          supportsImageInput: true,
          supportsToolImageInput: true,
          reasoningEffort: "default",
          omitThinkingFromRequests: false,
          activeImageModelId: expect.stringMatching(/^img_gpt_image_2_[a-f0-9]{6}$/),
          imageModels: [
            expect.objectContaining({
              id: expect.stringMatching(/^img_gpt_image_2_[a-f0-9]{6}$/),
              name: "gpt-image-2",
              imageBaseUrl: "https://api.openai.com/v1",
              imageApiKey: "img-secret",
              imageApiProtocol: "chat_completions",
              imageModel: "gpt-image-2"
            })
          ]
        })
      })
    );
  });

  it("merges imported new profile fields without writing legacy fields", async () => {
    getChrome().storage.local.get
      .mockResolvedValueOnce({
        [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION,
        llmConfig: {}
      })
      .mockResolvedValueOnce({
        llmConfig: {
          activeLlmModelId: "llm_old",
          llmModels: [
            {
              id: "llm_old",
              name: "old-model",
              apiType: "openai-chat-completions",
              baseUrl: "https://old.example/v1",
              apiKey: "old",
              model: "old-model"
            }
          ],
          supportsImageInput: true,
          supportsToolImageInput: true
        }
      });

    const result = await importSettingsBackupFromText(JSON.stringify({
      settings: {
        llmConfig: {
          activeLlmModelId: "llm_new",
          llmModels: [
            {
              id: "llm_new",
              name: "new-model",
              apiType: "openai-responses",
              baseUrl: "https://new.example/v1/responses",
              apiKey: "new",
              model: "new-model"
            }
          ],
          supportsToolImageInput: false
        }
      }
    }));

    expect(result.updatedKeys).toEqual(["llmConfig", SETTINGS_SCHEMA_VERSION_KEY]);
    expect(getChrome().storage.local.set).toHaveBeenLastCalledWith({
      llmConfig: {
        activeLlmModelId: "llm_new",
        llmModels: [
          {
            id: "llm_opencode_zen_big_pickle",
            name: "OpenCode Zen Big Pickle",
            apiType: "openai-chat-completions",
            baseUrl: "https://opencode.ai/zen/v1/chat/completions",
            apiKey: "",
            model: "big-pickle",
            nativeWebSearch: false,
            requiresApiKey: false
          },
          {
            id: "llm_new",
            name: "new-model",
            apiType: "openai-responses",
            baseUrl: "https://new.example/v1/responses",
            apiKey: "new",
            model: "new-model",
            nativeWebSearch: false
          }
        ],
        modelContextLimitTokens: 200000,
        firstPacketTimeoutSeconds: 20,
        supportsImageInput: true,
        supportsToolImageInput: false,
        reasoningEffort: "default",
        omitThinkingFromRequests: false,
        activeImageModelId: "",
        imageModels: []
      },
      [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION
    });
  });

  it("normalizes only present top-level whitelisted fields", async () => {
    const result = await importSettingsBackupFromText(JSON.stringify({
      settings: {
        reuse: true,
        extractTextLimit: 32000,
        bridgeEnabled: true
      }
    }));

    expect(result.updatedKeys).toEqual(["reuse", "extractTextLimit"]);
    expect(getChrome().storage.local.get).not.toHaveBeenCalled();
    expect(getChrome().storage.local.set).toHaveBeenCalledWith({
      reuse: true,
      extractTextLimit: 32000
    });
  });
});
