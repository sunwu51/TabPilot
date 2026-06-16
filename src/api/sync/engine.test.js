import { describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot, resetChromeMock } from "../../../test/setup";
import { STASH_STORAGE_KEY } from "../llm/core/constants";
import { GITHUB_SYNC_CONFIG_KEY, GITHUB_SYNC_STATE_KEY } from "./config";
import { runGithubSync } from "./engine";
import { encodeCompressedJson } from "./codec";
import { buildStashIndex, buildStashItemDocument, getStashItemId } from "./stashItems";

describe("github sync engine", () => {
  it("creates missing settings and stash files from local storage", async () => {
    resetChromeMock({
      llmConfig: { llmModels: [] },
      [STASH_STORAGE_KEY]: {
        "中文": { info: "内容", createdAt: 1, updatedAt: 2 }
      },
      [GITHUB_SYNC_CONFIG_KEY]: {
        enabled: true,
        owner: "me",
        repo: "sync",
        token: "token",
        basePath: "tabmanager",
        syncSettings: true,
        syncStash: true
      },
      [GITHUB_SYNC_STATE_KEY]: {
        deviceId: "dev_a",
        dirtySettings: true,
        dirtyStash: true,
        remoteShas: {}
      }
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "settings_sha" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "legacy_stash_sha", content: encodeCompressedJson({ stashes: { "中文": { info: "内容", createdAt: 1, updatedAt: 2 } } }) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "legacy_item_sha" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "migrated_index_sha" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "stash_item_sha" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "stash_sha" } }), { status: 200 }));

    const result = await runGithubSync({ force: true });
    const snapshot = getChromeStorageSnapshot();

    expect(result.success).toBe(true);
    expect(snapshot[GITHUB_SYNC_STATE_KEY].dirtySettings).toBe(false);
    expect(snapshot[GITHUB_SYNC_STATE_KEY].dirtyStash).toBe(false);
    expect(snapshot[GITHUB_SYNC_STATE_KEY].remoteShas).toEqual({
      settings: "settings_sha",
      stash: "stash_sha"
    });
  });

  it("pulls remote stash and merges it with local stash", async () => {
    const remoteTitle = "remote";
    const remoteStash = { info: "远端", createdAt: 2, updatedAt: 20 };
    const remoteIndex = buildStashIndex({ [remoteTitle]: remoteStash });
    resetChromeMock({
      [STASH_STORAGE_KEY]: {
        local: { info: "本机", createdAt: 1, updatedAt: 10 }
      },
      [GITHUB_SYNC_CONFIG_KEY]: {
        enabled: true,
        owner: "me",
        repo: "sync",
        token: "token",
        syncSettings: false,
        syncStash: true
      },
      [GITHUB_SYNC_STATE_KEY]: {
        deviceId: "dev_a",
        dirtyStash: false,
        remoteShas: {}
      }
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha: "remote_index_sha",
        content: encodeCompressedJson(remoteIndex)
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "local_item_sha" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha: "remote_item_sha",
        content: encodeCompressedJson(buildStashItemDocument(remoteTitle, remoteStash, "dev_b"))
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "merged_index_sha" } }), { status: 200 }));

    await runGithubSync();
    const snapshot = getChromeStorageSnapshot();

    expect(snapshot[STASH_STORAGE_KEY].local.info).toBe("本机");
    expect(snapshot[STASH_STORAGE_KEY].remote.info).toBe("远端");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2][0]).toContain(`/stash/items/${getStashItemId(remoteTitle)}.json.deflate.b64`);
  });

  it("overwrites unreadable remote stash index with local index", async () => {
    resetChromeMock({
      [STASH_STORAGE_KEY]: {
        local: { info: "本机", createdAt: 1, updatedAt: 10 }
      },
      [GITHUB_SYNC_CONFIG_KEY]: {
        enabled: true,
        owner: "me",
        repo: "sync",
        token: "token",
        syncSettings: false,
        syncStash: true
      },
      [GITHUB_SYNC_STATE_KEY]: {
        deviceId: "dev_a",
        dirtyStash: false,
        remoteShas: {}
      }
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha: "bad_index_sha",
        content: "not-deflate-json"
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "local_item_sha" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "fixed_index_sha" } }), { status: 200 }));

    await runGithubSync();
    const indexPutBody = JSON.parse(fetch.mock.calls[2][1].body);

    expect(indexPutBody.sha).toBe("bad_index_sha");
    expect(getChromeStorageSnapshot()[STASH_STORAGE_KEY].local.info).toBe("本机");
  });

});
