import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_BACKUP_KEYS,
  exportSettingsBackup,
  importSettingsBackupFromText
} from "./settingsBackup";

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

  it("exports only whitelisted settings", async () => {
    getChrome().storage.local.get.mockResolvedValueOnce({
      llmConfig: { apiKey: "secret" },
      reuse: true,
      mcpServers: [{ url: "https://example.com" }]
    });

    const backup = await exportSettingsBackup();

    expect(getChrome().storage.local.get).toHaveBeenCalledWith(SETTINGS_BACKUP_KEYS);
    expect(backup.settings).toEqual({
      llmConfig: { apiKey: "secret" },
      reuse: true
    });
  });

  it("merges imported llmConfig fields without clearing missing fields", async () => {
    getChrome().storage.local.get.mockResolvedValueOnce({
      llmConfig: {
        apiType: "anthropic",
        baseUrl: "https://api.example/messages",
        apiKey: "old",
        model: "old-model"
      }
    });

    const result = await importSettingsBackupFromText(JSON.stringify({
      settings: {
        llmConfig: {
          apiKey: "new"
        },
        mcpServers: [{ url: "ignored" }]
      }
    }));

    expect(result.updatedKeys).toEqual(["llmConfig"]);
    expect(getChrome().storage.local.set).toHaveBeenCalledWith({
      llmConfig: {
        apiType: "anthropic",
        baseUrl: "https://api.example/messages",
        apiKey: "new",
        model: "old-model"
      }
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
