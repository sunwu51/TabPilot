import { describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot, resetChromeMock } from "../../../test/setup";
import { syncAllSessionsWithSupabase } from "./backup";
import { SUPABASE_CONFIG_KEY } from "./config";

describe("Supabase session sync", () => {
  it("keeps the session with the latest updatedAt on either side", async () => {
    resetChromeMock({
      [SUPABASE_CONFIG_KEY]: {
        url: "https://demo.supabase.co",
        key: "anon-key",
        bucket: "tabmanager",
        basePath: "tabmanager"
      },
      sessions_index: [
        { id: "local_newer", title: "local", updatedAt: 300 },
        { id: "remote_newer", title: "old local", updatedAt: 100 },
        { id: "equal", title: "equal local", updatedAt: 200 },
        { id: "local_only", title: "local only", updatedAt: 150 }
      ],
      session_local_newer: { messages: ["local newest"] },
      session_remote_newer: { messages: ["local old"] },
      session_equal: { messages: ["equal"] },
      session_local_only: { messages: ["local only"] }
    });

    const remoteManifest = {
      format: "tab-manager-sessions",
      version: 2,
      sessions: {
        local_newer: { path: "tabmanager/sessions/local_newer.json", updatedAt: 100 },
        remote_newer: { path: "tabmanager/sessions/remote_newer.json", updatedAt: 400 },
        equal: { path: "tabmanager/sessions/equal.json", updatedAt: 200 },
        remote_only: { path: "tabmanager/sessions/remote_only.json", updatedAt: 250 }
      }
    };
    const remotePayloads = {
      remote_newer: {
        entry: { id: "remote_newer", title: "remote", updatedAt: 400 },
        session: { messages: ["remote newest"] },
        images: { img_1: "data:image/png;base64,eA==" }
      },
      remote_only: {
        entry: { id: "remote_only", title: "remote only", updatedAt: 250 },
        session: { messages: ["remote only"] },
        images: {}
      }
    };
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || "GET", body: options.body });
      if (String(url).endsWith("/tabmanager/sessions/manifest.json") && !options.method) return jsonResponse(remoteManifest);
      for (const [id, payload] of Object.entries(remotePayloads)) {
        if (String(url).endsWith(`/tabmanager/sessions/${id}.json`) && !options.method) return jsonResponse(payload);
      }
      return jsonResponse({ Key: "ok" });
    }));

    const result = await syncAllSessionsWithSupabase();
    expect(result).toMatchObject({ total: 5, uploadedCount: 2, downloadedCount: 2, unchangedCount: 1, settings: "uploaded" });

    const snapshot = getChromeStorageSnapshot();
    expect(snapshot.session_local_newer.messages).toEqual(["local newest"]);
    expect(snapshot.session_remote_newer.messages).toEqual(["remote newest"]);
    expect(snapshot.session_remote_newer_images).toEqual({ img_1: "data:image/png;base64,eA==" });
    expect(snapshot.session_remote_only.messages).toEqual(["remote only"]);
    expect(snapshot.sessions_index.map(item => item.id).sort()).toEqual([
      "equal", "local_newer", "local_only", "remote_newer", "remote_only"
    ]);

    const uploadedSessionUrls = requests
      .filter(request => request.method === "POST" && /\/sessions\/[^/]+\.json$/.test(request.url) && !request.url.endsWith("/manifest.json"))
      .map(request => request.url);
    expect(uploadedSessionUrls).toHaveLength(2);
    expect(uploadedSessionUrls.some(url => url.endsWith("/local_newer.json"))).toBe(true);
    expect(uploadedSessionUrls.some(url => url.endsWith("/local_only.json"))).toBe(true);
  });

  it("downloads newer settings without replacing newer local settings", async () => {
    resetChromeMock({
      [SUPABASE_CONFIG_KEY]: { url: "https://demo.supabase.co", key: "anon-key", bucket: "tabmanager", basePath: "tabmanager" },
      sessions_index: [],
      reuse: false,
      supabaseSettingsSyncState: { updatedAt: 100 }
    });
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/tabmanager/sessions/manifest.json") && !options.method) return jsonResponse(emptyManifest());
      if (String(url).endsWith("/tabmanager/config/settings.json") && !options.method) {
        return jsonResponse({
          format: "tab-manager-supabase-settings",
          version: 1,
          updatedAt: 200,
          backup: { settings: { reuse: true } }
        });
      }
      return jsonResponse({ Key: "ok" });
    }));

    const result = await syncAllSessionsWithSupabase();
    expect(result.settings).toBe("downloaded");
    expect(getChromeStorageSnapshot().reuse).toBe(true);
    expect(getChromeStorageSnapshot().supabaseSettingsSyncState.updatedAt).toBe(200);
  });
});

function emptyManifest() {
  return { format: "tab-manager-sessions", version: 2, sessions: {} };
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}
