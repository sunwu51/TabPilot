/* global chrome */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot } from "../../../test/setup";
import { syncContentTypeHeader } from "../../component/postdog/postdogUtils";
import {
  POSTDOG_ACTIVE_ENVIRONMENT_KEY,
  POSTDOG_ENVIRONMENTS_KEY,
  POSTDOG_FOLDERS_KEY,
  POSTDOG_HISTORY_KEY,
  POSTDOG_REQUESTS_KEY,
  listPostdogEnvironments,
  listPostdogFolders,
  listPostdogRequests,
  savePostdogEnvironment,
  savePostdogRequest
} from "./index";
import { runPostdogRequest } from "./runtime";

describe("postdog data compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads data saved by older versions (minimal fields) and can still run it", async () => {
    // Shapes written by 1.5.6.x before the Postdog redesign: no query, no secret flag, no fields.
    await chrome.storage.local.set({
      [POSTDOG_FOLDERS_KEY]: [{ id: "f1", name: "Old folder", preScript: "postdog.request.headers.set('X-Old', '1')" }],
      [POSTDOG_REQUESTS_KEY]: [{
        id: "r1",
        name: "Old request",
        folderId: "f1",
        method: "post",
        url: "https://api.example.com/{{path}}",
        headers: [{ key: "Authorization", value: "Bearer {{token}}", enabled: true }],
        body: { type: "json", text: "{\"a\":1}" },
        preScript: "postdog.env.set('seen', '1')"
      }],
      [POSTDOG_ENVIRONMENTS_KEY]: [{ id: "e1", name: "local", variables: [{ key: "path", value: "items" }, { key: "token", value: "t" }] }],
      [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "e1",
      [POSTDOG_HISTORY_KEY]: [{ runId: "old-run", requestId: "r1", method: "GET", url: "https://x", status: 200, response: { bodyText: "ok" } }]
    });

    const [requests, folders, envs] = await Promise.all([listPostdogRequests(), listPostdogFolders(), listPostdogEnvironments()]);
    expect(requests[0]).toMatchObject({ id: "r1", method: "POST", query: [], body: { type: "json", fields: [] } });
    expect(folders[0].postScript).toBe("");
    expect(envs[0].variables).toHaveLength(2);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const result = await runPostdogRequest({ id: "r1" });

    expect(fetch.mock.calls[0][0]).toBe("https://api.example.com/items");
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer t", "X-Old": "1", "Content-Type": "application/json" });
    expect(result.success).toBe(true);
    // the pre-existing history entry is kept alongside the new one
    const history = getChromeStorageSnapshot()[POSTDOG_HISTORY_KEY];
    expect(history.map(item => item.runId)).toContain("old-run");
    expect(history).toHaveLength(2);
  });
});

describe("postdog script errors and history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send the request when a pre script fails, but returns logs and records history", async () => {
    await savePostdogEnvironment({ id: "env-1", name: "local", variables: [] });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-err",
      name: "broken",
      method: "GET",
      url: "https://api.example.com/x",
      preScript: "console.log('before'); throw new Error('token missing');",
      postScript: "console.log('post should not run');"
    });
    vi.stubGlobal("fetch", vi.fn());

    const result = await runPostdogRequest({ id: request.id });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.scriptFailed).toBe(true);
    expect(result.response.statusText).toBe("NOT_SENT");
    expect(result.logs).toEqual([
      expect.objectContaining({ level: "info", message: "before", phase: "pre" }),
      expect.objectContaining({ level: "error", message: expect.stringContaining("token missing"), phase: "pre" })
    ]);
    expect(result.request.sent).toBe(false);
    expect(getChromeStorageSnapshot()[POSTDOG_HISTORY_KEY][0].logs).toHaveLength(2);
  });

  it("keeps going when a post script fails and runs the folder post script anyway", async () => {
    await savePostdogEnvironment({ id: "env-1", name: "local", variables: [] });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    await chrome.storage.local.set({ [POSTDOG_FOLDERS_KEY]: [{ id: "f1", name: "F", postScript: "$.test('folder post ran', true)" }] });
    const request = await savePostdogRequest({
      id: "req-post-err",
      name: "post err",
      folderId: "f1",
      method: "GET",
      url: "https://api.example.com/x",
      postScript: "nope.undefined.call()"
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hi", { status: 200 })));

    const result = await runPostdogRequest({ id: request.id });

    expect(result.response.status).toBe(200);
    expect(result.tests).toEqual({ "folder post ran": true });
    expect(result.logs.some(log => log.level === "error" && log.phase === "post")).toBe(true);
  });

  it("records the full request, template, environment and response in history", async () => {
    await savePostdogEnvironment({ id: "env-1", name: "staging", variables: [{ key: "host", value: "api.example.com", enabled: true }] });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-hist",
      name: "history",
      method: "POST",
      url: "https://{{host}}/items",
      headers: [{ key: "X-Test", value: "1", enabled: true }],
      query: [{ key: "q", value: "{{host}}", enabled: true }],
      body: { type: "json", text: "{\"a\":\"{{host}}\"}" }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "X-Reply": "yes" } })));

    await runPostdogRequest({ id: request.id });

    const entry = getChromeStorageSnapshot()[POSTDOG_HISTORY_KEY][0];
    expect(entry.request).toMatchObject({
      method: "POST",
      url: "https://api.example.com/items?q=api.example.com",
      headers: expect.objectContaining({ "X-Test": "1", "Content-Type": "application/json" }),
      body: "{\"a\":\"api.example.com\"}",
      environment: { name: "staging" },
      template: { url: "https://{{host}}/items", query: [expect.objectContaining({ key: "q", value: "{{host}}" })] }
    });
    expect(entry.response).toMatchObject({ status: 201, headers: expect.objectContaining({ "x-reply": "yes" }), bodyJson: { ok: 1 } });
  });

  it("applies the User-Agent header through a temporary network rule", async () => {
    const updateSessionRules = vi.fn(async () => {});
    vi.stubGlobal("chrome", { ...chrome, runtime: { ...chrome.runtime, id: "ext-id" }, declarativeNetRequest: { updateSessionRules } });
    await savePostdogEnvironment({ id: "env-1", name: "local", variables: [] });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-ua",
      name: "ua",
      method: "GET",
      url: "https://api.example.com/a.b?x=1",
      headers: [{ key: "User-Agent", value: "Postdog/1.0", enabled: true }]
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    await runPostdogRequest({ id: request.id });

    expect(updateSessionRules).toHaveBeenCalledTimes(2);
    const added = updateSessionRules.mock.calls[0][0].addRules[0];
    expect(added.action.requestHeaders[0]).toMatchObject({ header: "User-Agent", operation: "set", value: "Postdog/1.0" });
    expect(added.condition.regexFilter).toBe("^https://api\\.example\\.com/a\\.b\\?x=1$");
    expect(added.condition.initiatorDomains).toEqual(["ext-id"]);
    expect(updateSessionRules.mock.calls[1][0]).toEqual({ removeRuleIds: [added.id] });
  });
});

describe("content-type sync with body type", () => {
  it("adds, replaces and removes only values it owns", () => {
    expect(syncContentTypeHeader([], "json")).toEqual([{ key: "Content-Type", value: "application/json", enabled: true }]);
    expect(syncContentTypeHeader([{ key: "content-type", value: "application/json", enabled: true }], "form"))
      .toEqual([{ key: "content-type", value: "application/x-www-form-urlencoded", enabled: true }]);
    expect(syncContentTypeHeader([{ key: "Content-Type", value: "application/json", enabled: true }], "multipart")).toEqual([]);
    expect(syncContentTypeHeader([{ key: "Content-Type", value: "application/json", enabled: true }], "none")).toEqual([]);
    const custom = [{ key: "Content-Type", value: "application/vnd.api+json", enabled: true }];
    expect(syncContentTypeHeader(custom, "json")).toBe(custom);
    expect(syncContentTypeHeader(custom, "none")).toBe(custom);
  });
});
