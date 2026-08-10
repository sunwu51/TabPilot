import { describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot, resetChromeMock } from "../../../test/setup";
import { overwriteSupabaseSettingsFromLocal, restoreSettingsFromSupabase, syncSessionsWithSupabase } from "./backup";
import { SUPABASE_CONFIG_KEY } from "./config";

const config = { url: "https://demo.supabase.co", key: "anon-key", bucket: "tabmanager", basePath: "tabmanager" };

describe("Supabase session sync and directional settings backup", () => {
  it("merges sessions and keeps the latest updatedAt on either side", async () => {
    resetChromeMock({
      [SUPABASE_CONFIG_KEY]: config,
      sessions_index: [
        { id: "local_newer", title: "local", updatedAt: 300 },
        { id: "remote_newer", title: "old local", updatedAt: 100 },
        { id: "local_only", title: "local only", updatedAt: 150 }
      ],
      session_local_newer: { messages: ["local newest"] },
      session_remote_newer: { messages: ["local old"] },
      session_local_only: { messages: ["local only"] }
    });
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || "GET" });
      if (!options.method && String(url).endsWith("/sessions/manifest.json")) return jsonResponse(remoteManifest());
      if (!options.method && String(url).endsWith("/sessions/remote_newer.json")) {
        return jsonResponse({ entry: { id: "remote_newer", title: "remote", updatedAt: 400 }, session: { messages: ["remote newest"] }, images: {} });
      }
      if (!options.method && String(url).endsWith("/sessions/remote_only.json")) {
        return jsonResponse({ entry: { id: "remote_only", title: "remote only", updatedAt: 250 }, session: { messages: ["remote only"] }, images: {} });
      }
      return jsonResponse({ Key: "ok" });
    }));

    const result = await syncSessionsWithSupabase();
    expect(result).toMatchObject({ total: 4, uploadedCount: 2, downloadedCount: 2 });
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot.session_remote_newer.messages).toEqual(["remote newest"]);
    expect(snapshot.session_remote_only.messages).toEqual(["remote only"]);
    expect(snapshot.sessions_index.map(item => item.id).sort()).toEqual(["local_newer", "local_only", "remote_newer", "remote_only"]);
    expect(requests.some(request => request.url.endsWith("/config/settings.json"))).toBe(false);
  });

  it("restores only settings without changing sessions", async () => {
    const sessionState = {
      sessions_index: [{ id: "local", title: "Local", updatedAt: 300 }],
      session_local: { messages: ["local"] },
      session_local_images: { image: "data" }
    };
    resetChromeMock({ [SUPABASE_CONFIG_KEY]: config, ...sessionState, reuse: false, hideCopyButton: true });
    vi.stubGlobal("fetch", vi.fn(async url => {
      if (String(url).endsWith("/config/settings.json")) {
        return jsonResponse({ format: "tab-manager-supabase-settings", version: 1, updatedAt: 200, backup: { settings: { reuse: true } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(restoreSettingsFromSupabase()).resolves.toEqual({ updatedKeyCount: 1 });
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot.reuse).toBe(true);
    expect(snapshot.hideCopyButton).toBeUndefined();
    expect(snapshot.sessions_index).toEqual(sessionState.sessions_index);
    expect(snapshot.session_local).toEqual(sessionState.session_local);
    expect(snapshot.session_local_images).toEqual(sessionState.session_local_images);
  });

  it("overwrites only remote settings without reading or writing sessions", async () => {
    const sessionState = {
      sessions_index: [{ id: "local", title: "Local", updatedAt: 300 }],
      session_local: { messages: ["local"] }
    };
    resetChromeMock({ [SUPABASE_CONFIG_KEY]: config, ...sessionState, reuse: false });
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || "GET" });
      return jsonResponse({ Key: "ok" });
    }));

    await overwriteSupabaseSettingsFromLocal();
    expect(requests).toEqual([
      expect.objectContaining({ method: "POST", url: expect.stringMatching(/\/config\/settings\.json$/) })
    ]);
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot.sessions_index).toEqual(sessionState.sessions_index);
    expect(snapshot.session_local).toEqual(sessionState.session_local);
  });

  it("does not write when reading the session manifest fails", async () => {
    resetChromeMock({ [SUPABASE_CONFIG_KEY]: config, sessions_index: [] });
    const fetchMock = vi.fn(async () => errorResponse(500, "temporary failure"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncSessionsWithSupabase()).rejects.toThrow("temporary failure");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function remoteManifest() {
  return {
    format: "tab-manager-sessions",
    version: 2,
    sessions: {
      local_newer: { path: "tabmanager/sessions/local_newer.json", updatedAt: 100 },
      remote_newer: { path: "tabmanager/sessions/remote_newer.json", updatedAt: 400 },
      remote_only: { path: "tabmanager/sessions/remote_only.json", updatedAt: 250 }
    }
  };
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => JSON.stringify(value) };
}

function errorResponse(status, message) {
  return jsonResponse({ message }, status);
}
