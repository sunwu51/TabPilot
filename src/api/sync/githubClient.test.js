import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGithubSyncFile, getGithubSyncFileLenient, putGithubSyncFile } from "./githubClient";
import { encodeCompressedJson } from "./codec";

describe("github sync client", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it("reads compressed JSON from the contents API", async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      sha: "sha_1",
      content: encodeCompressedJson({ text: "你好" })
    }), { status: 200 }));

    const file = await getGithubSyncFile(makeConfig(), "tabmanager/settings.json.deflate.b64");

    expect(file).toEqual({ sha: "sha_1", content: { text: "你好" } });
    expect(fetch.mock.calls[0][0]).toContain("/repos/me/sync/contents/tabmanager/settings.json.deflate.b64");
  });

  it("returns sha for unreadable content in lenient mode", async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      sha: "sha_bad",
      content: "not-deflate-json"
    }), { status: 200 }));

    const file = await getGithubSyncFileLenient(makeConfig(), "tabmanager/stash/index.json.deflate.b64");

    expect(file.sha).toBe("sha_bad");
    expect(file.unreadable).toBe(true);
  });

  it("writes compressed JSON with the existing sha", async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      content: { sha: "sha_2" },
      commit: { sha: "commit_1" }
    }), { status: 200 }));

    const result = await putGithubSyncFile(makeConfig(), "tabmanager/settings.json.deflate.b64", { text: "你好" }, { sha: "sha_1" });
    const body = JSON.parse(fetch.mock.calls[0][1].body);

    expect(result.sha).toBe("sha_2");
    expect(body.sha).toBe("sha_1");
    expect(body.content).toEqual(expect.any(String));
  });

  it("retries when GitHub asks for sha with status 400", async () => {
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid request. \"sha\" wasn't supplied." }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "sha_existing", content: encodeCompressedJson({ text: "old" }) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "sha_new" }, commit: { sha: "commit_new" } }), { status: 200 }));

    const result = await putGithubSyncFile(makeConfig(), "tabmanager/settings.json.deflate.b64", { text: "你好" });

    expect(result.sha).toBe("sha_new");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries when GitHub asks for sha with status 422", async () => {
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid request. \"sha\" wasn't supplied." }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "sha_existing", content: encodeCompressedJson({ text: "old" }) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "sha_new_422" }, commit: { sha: "commit_new_422" } }), { status: 200 }));

    const result = await putGithubSyncFile(makeConfig(), "tabmanager/settings.json.deflate.b64", { text: "你好" });

    expect(result.sha).toBe("sha_new_422");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries missing sha even when existing content is unreadable", async () => {
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid request.\n\n\"sha\" wasn't supplied." }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "sha_existing", content: "not-deflate-json" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { sha: "sha_new_bad_content" } }), { status: 200 }));

    const result = await putGithubSyncFile(makeConfig(), "tabmanager/stash/index.json.deflate.b64", { items: {} });

    expect(result.sha).toBe("sha_new_bad_content");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

function makeConfig() {
  return {
    owner: "me",
    repo: "sync",
    branch: "",
    token: "ghp_test"
  };
}
