/* global chrome */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot } from "../../../test/setup";
import {
  POSTDOG_ACTIVE_ENVIRONMENT_KEY,
  POSTDOG_ENVIRONMENTS_KEY,
  POSTDOG_HISTORY_KEY,
  savePostdogEnvironment,
  savePostdogFolder,
  savePostdogRequest
} from "./index";
import { runPostdogRequest } from "./runtime";

describe("postdog runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets post scripts save response values into the active environment", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: [{ key: "baseUrl", value: "https://api.example.com", enabled: true }]
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-1",
      name: "create item",
      method: "POST",
      url: "{{baseUrl}}/items",
      headers: [],
      body: { type: "json", text: "{\"name\":\"a\"}" },
      postScript: "await postdog.env.set('objId', postdog.response.json().id); postdog.tests.set('saved id', postdog.env.get('objId') === 'obj-1');"
    });

    vi.stubGlobal("fetch", vi.fn(async (url, init) => new Response(
      JSON.stringify({ id: "obj-1" }),
      { status: 201, headers: { "Content-Type": "application/json", "X-Url": url, "X-Method": init.method } }
    )));

    const result = await runPostdogRequest({ id: request.id });

    expect(result.runId).toMatch(/^pdh_/);
    expect(fetch).toHaveBeenCalledWith("https://api.example.com/items", expect.objectContaining({
      method: "POST",
      body: "{\"name\":\"a\"}"
    }));
    expect(result.tests).toEqual({ "saved id": true });
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot[POSTDOG_ENVIRONMENTS_KEY][0].variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "objId", value: "obj-1" })
    ]));
    expect(snapshot[POSTDOG_HISTORY_KEY][0]).toMatchObject({
      runId: result.runId,
      requestId: request.id,
      status: 201,
      request: expect.objectContaining({
        url: "https://api.example.com/items",
        body: "{\"name\":\"a\"}"
      }),
      response: expect.objectContaining({
        status: 201,
        bodyJson: { id: "obj-1" }
      })
    });
  });

  it("supports const bindings in scripts without unsafe eval", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: []
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-2",
      name: "create item",
      method: "POST",
      url: "https://api.example.com/items",
      headers: [],
      body: { type: "none", text: "" },
      postScript: [
        "const body = postdog.response.json();",
        "postdog.env.set('objId', body.id);",
        "postdog.tests.set('created', postdog.response.status === 201);"
      ].join("\n")
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ id: "obj-2" }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    )));

    const result = await runPostdogRequest({ id: request.id });

    expect(result.tests).toEqual({ created: true });
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot[POSTDOG_ENVIRONMENTS_KEY][0].variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "objId", value: "obj-2" })
    ]));
  });

  it("runs folder scripts and built-in template functions", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: []
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const folder = await savePostdogFolder({
      id: "folder-1",
      name: "common",
      preScript: "postdog.request.headers.set('X-Folder', 'folder-pre');",
      postScript: "postdog.env.set('folderStatus', postdog.response.status);"
    });
    const request = await savePostdogRequest({
      id: "req-3",
      name: "with folder",
      folderId: folder.id,
      method: "POST",
      url: "https://api.example.com/items/{{$guid()}}?ts={{$timestamp()}}",
      headers: [],
      body: { type: "json", text: "{\"createdAt\":\"{{$now()}}\"}" },
      preScript: "postdog.request.headers.set('X-Request', 'request-pre');"
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await runPostdogRequest({ id: request.id });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/^https:\/\/api\.example\.com\/items\/[0-9a-f-]{36}\?ts=\d+$/);
    expect(init.headers).toMatchObject({
      "X-Folder": "folder-pre",
      "X-Request": "request-pre"
    });
    expect(init.body).toMatch(/"createdAt":"\d{4}-\d{2}-\d{2}T/);
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot[POSTDOG_ENVIRONMENTS_KEY][0].variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "folderStatus", value: "200" })
    ]));
  });

  it("runs modern script syntax while hiding chrome globals", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: []
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-4",
      name: "modern script",
      method: "POST",
      url: "https://api.example.com/items",
      headers: [],
      body: { type: "none", text: "" },
      preScript: [
        "const items = [1, 2, 3].map(value => value * 2);",
        "request.headers.set('X-Sum', String(items.reduce((sum, value) => sum + value, 0)));",
        "postdog.tests.set('chrome hidden', typeof chrome === 'undefined' && globalThis.chrome === undefined);",
        "console.log(`sum:${items.join(',')}`);"
      ].join("\n"),
      postScript: "await postdog.env.set('statusFromModernScript', response.status);"
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));

    const result = await runPostdogRequest({ id: request.id });

    expect(fetch).toHaveBeenCalledWith("https://api.example.com/items", expect.objectContaining({
      headers: expect.objectContaining({ "X-Sum": "12" })
    }));
    expect(result.tests).toEqual({ "chrome hidden": true });
    expect(result.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "info", message: "sum:2,4,6" })
    ]));
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot[POSTDOG_ENVIRONMENTS_KEY][0].variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "statusFromModernScript", value: "202" })
    ]));
  });

  it("prevents scripts from injecting a chrome global", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: []
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-5",
      name: "chrome guard",
      method: "GET",
      url: "https://api.example.com/items",
      headers: [],
      body: { type: "none", text: "" },
      postScript: "globalThis.chrome = { tabs: {} }; postdog.tests.set('should not run', true);"
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const result = await runPostdogRequest({ id: request.id });

    expect(result.success).toBe(true);
    expect(result.tests).toEqual({});
    expect(result.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "error",
        phase: "post",
        message: expect.stringContaining("chrome")
      })
    ]));
  });

  it("prints environment snapshots without leaking secret values", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: [
        { key: "baseUrl", value: "https://api.example.com", enabled: true },
        { key: "token", value: "secret-token", enabled: true, secret: true }
      ]
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-6",
      name: "print env",
      method: "GET",
      url: "{{baseUrl}}/items",
      headers: [],
      body: { type: "none", text: "" },
      preScript: [
        "console.log(environment);",
        "console.log(variables.all());",
        "postdog.log(postdog.env.all());"
      ].join("\n")
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const result = await runPostdogRequest({ id: request.id });

    expect(result.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("\"baseUrl\":\"https://api.example.com\"") }),
      expect.objectContaining({ message: expect.stringContaining("\"token\":\"***\"") })
    ]));
    expect(JSON.stringify(result.logs)).not.toContain("secret-token");
  });
});
