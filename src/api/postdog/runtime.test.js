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
import { formatJsonWithComments, normalizeJsonRequestBody, stripJsonComments } from "./json";
import { exportPostdogCurl, runPostdogFlowScript, runPostdogRequest } from "./runtime";

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

  it("keeps binary responses out of body text and history", async () => {
    const request = await savePostdogRequest({
      id: "req-binary",
      name: "download pdf",
      method: "GET",
      url: "https://api.example.com/report.pdf",
      headers: [],
      body: { type: "none", text: "" }
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "4",
          "Content-Disposition": "attachment; filename*=UTF-8''report%20final.pdf"
        }
      }
    )));

    const result = await runPostdogRequest({ id: request.id });
    const snapshot = getChromeStorageSnapshot();

    expect(result.response).toMatchObject({
      bodyKind: "binary",
      bodyText: "",
      bodyJson: null,
      bodySizeBytes: 4,
      bodyTruncated: false,
      download: {
        fileName: "report final.pdf",
        mimeType: "application/pdf",
        dataBase64: "JVBERg=="
      }
    });
    expect(result.response.bodyNote).toContain("文件响应已就绪");
    expect(snapshot[POSTDOG_HISTORY_KEY][0].response).toMatchObject({
      bodyKind: "binary",
      bodyText: "",
      bodyJson: null
    });
    expect(snapshot[POSTDOG_HISTORY_KEY][0].response).not.toHaveProperty("download");
  });

  it("sends urlencoded form fields with variables and repeated keys", async () => {
    await savePostdogEnvironment({
      id: "env-form",
      name: "form",
      variables: [{ key: "item", value: "two words", enabled: true }]
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-form" });
    const request = await savePostdogRequest({
      id: "req-form",
      name: "form",
      method: "POST",
      url: "https://api.example.com/form",
      body: {
        type: "form",
        fields: [
          { key: "tag", value: "one", enabled: true },
          { key: "tag", value: "{{item}}", enabled: true },
          { key: "skip", value: "no", enabled: false }
        ]
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await runPostdogRequest({ id: request.id });

    const init = fetch.mock.calls[0][1];
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe("tag=one&tag=two+words");
  });

  it("sends multipart text and file fields without forcing a content-type boundary", async () => {
    const request = await savePostdogRequest({
      id: "req-multipart",
      name: "upload",
      method: "POST",
      url: "https://api.example.com/upload",
      headers: [{ key: "Content-Type", value: "multipart/form-data", enabled: true }],
      body: {
        type: "multipart",
        fields: [
          { key: "caption", value: "hello", kind: "text", enabled: true },
          {
            key: "file",
            kind: "file",
            fileName: "hello.txt",
            mimeType: "text/plain",
            dataBase64: "aGk=",
            enabled: true
          }
        ]
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await runPostdogRequest({ id: request.id });

    const init = fetch.mock.calls[0][1];
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("caption")).toBe("hello");
    const file = init.body.get("file");
    expect(file.name).toBe("hello.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("hi");
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot[POSTDOG_HISTORY_KEY][0].request.body).toBe([
      "caption: hello",
      "file: [file hello.txt, text/plain, 2 bytes]"
    ].join("\n"));
  });

  it("stores a bounded preview for stream responses", async () => {
    const request = await savePostdogRequest({
      id: "req-stream",
      name: "events",
      method: "GET",
      url: "https://api.example.com/events",
      headers: [],
      body: { type: "none", text: "" },
      postScript: "postdog.tests.set('preview visible', postdog.response.text().includes('data: one'));"
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        controller.close();
      }
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      stream,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    )));

    const result = await runPostdogRequest({ id: request.id });

    expect(result.response).toMatchObject({
      bodyKind: "stream",
      bodyText: "data: one\n\n",
      bodyJson: null,
      bodyTruncated: false
    });
    expect(result.response.bodyNote).toContain("流式响应");
    expect(result.tests).toEqual({ "preview visible": true });
  });

  it("strips JSON body comments before sending without changing strings", async () => {
    const request = await savePostdogRequest({
      id: "req-json-comments",
      name: "json comments",
      method: "POST",
      url: "https://api.example.com/items",
      headers: [],
      body: {
        type: "json",
        text: [
          "{",
          "  // line comment",
          "  \"url\": \"https://example.com/a//b\",",
          "  /* block comment */",
          "  \"note\": \"keep /* text */\",",
          "  \"ok\": true",
          "}"
        ].join("\n")
      }
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await runPostdogRequest({ id: request.id });

    expect(fetch).toHaveBeenCalledWith("https://api.example.com/items", expect.objectContaining({
      body: JSON.stringify({
        url: "https://example.com/a//b",
        note: "keep /* text */",
        ok: true
      })
    }));
  });

  it("normalizes JSON comments for preview and transport helpers", () => {
    const input = [
      "{",
      "  /** block doc comment */",
      "  \"a\": 1, // comment",
      "  \"b\": \"http://x/y\",",
      "}"
    ].join("\n");

    expect(stripJsonComments(input)).toContain('"b": "http://x/y"');
    expect(normalizeJsonRequestBody(input)).toBe('{"a":1,"b":"http://x/y"}');
  });

  it("formats JSON body without removing comments", () => {
    const input = '{"a":1,// keep line\n"b":{"c":2},/* keep block */"d":3}';

    const formatted = formatJsonWithComments(input, 2);

    expect(formatted).toContain("// keep line");
    expect(formatted).toContain("/* keep block */");
    expect(formatted).toContain('  "c": 2');
    expect(normalizeJsonRequestBody(formatted)).toBe('{"a":1,"b":{"c":2},"d":3}');
  });
  it("exposes $ as a shortcut with batch setters for env, headers, query and body", async () => {
    await savePostdogEnvironment({ id: "env-1", name: "local", variables: [{ key: "old", value: "x", enabled: true }] });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });
    const request = await savePostdogRequest({
      id: "req-dollar",
      name: "dollar",
      method: "POST",
      url: "https://api.example.com/items",
      headers: [{ key: "X-Remove", value: "1", enabled: true }],
      preScript: [
        "$.request.headers.set({ 'X-A': 'a', 'X-B': 2 });",
        "$.request.headers.unset('X-Remove');",
        "$.request.query.set({ page: 1, size: 20 });",
        "$.request.body.set({ name: 'n', n: 1 });"
      ].join("\n"),
      postScript: [
        "await $.env.set({ token: $.response.json().token, status: $.response.status });",
        "await $.env.unset('old');",
        "$.test('has token', $.env.has('token') && !$.env.has('old'));"
      ].join("\n")
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "t-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    const result = await runPostdogRequest({ id: request.id });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/items?page=1&size=20");
    expect(init.headers).toMatchObject({ "X-A": "a", "X-B": "2", "Content-Type": "application/json" });
    expect(init.headers["X-Remove"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ name: "n", n: 1 });
    expect(result.tests).toEqual({ "has token": true });
    const variables = getChromeStorageSnapshot()[POSTDOG_ENVIRONMENTS_KEY][0].variables;
    expect(variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "token", value: "t-1" }),
      expect.objectContaining({ key: "status", value: "200" })
    ]));
    expect(variables.some(item => item.key === "old")).toBe(false);
  });

  it("provides $.sleep(ms) in pre and post scripts", async () => {
    vi.useFakeTimers();
    try {
      const request = await savePostdogRequest({
        id: "req-sleep",
        name: "sleep",
        method: "GET",
        url: "https://api.example.com/sleep",
        preScript: "await $.sleep(1000); $.request.headers.set('X-Slept', 'yes');",
        postScript: "await postdog.sleep(500); $.test('slept', true);"
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));

      const pending = runPostdogRequest({ id: request.id });
      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;

      expect(fetch.mock.calls[0][1].headers).toMatchObject({ "X-Slept": "yes" });
      expect(result.tests).toEqual({ slept: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps request scripts with flow scripts and reports pass/fail by thrown errors only", async () => {
    await savePostdogFolder({ id: "fold-flow", name: "api", preScript: "$.log('folder pre')", postScript: "$.log('folder post')" });
    const request = await savePostdogRequest({
      id: "req-flow",
      name: "flow req",
      folderId: "fold-flow",
      method: "GET",
      url: "https://api.example.com/flow",
      preScript: "$.log('request pre')",
      postScript: "$.log('request post'); $.test('not 2xx', $.response.ok);"
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const ok = await runPostdogRequest({ id: request.id, flow: { preScript: "$.log('flow pre')", postScript: "$.log('flow post')" } });
    expect(ok.logs.map(log => log.message)).toEqual(["folder pre", "flow pre", "request pre", "request post", "flow post", "folder post"]);
    // A 500 and a failed $.test are not failures; only thrown errors are.
    expect(ok.passed).toBe(true);

    const failed = await runPostdogRequest({ id: request.id, flow: { postScript: "$.assert($.response.ok, 'HTTP ' + $.response.status)" } });
    expect(failed.passed).toBe(false);
    expect(failed.logs.find(log => log.level === "error")).toMatchObject({ phase: "flow_post", message: "HTTP 500" });

    fetch.mockClear();
    const aborted = await runPostdogRequest({ id: request.id, flow: { preScript: "throw new Error('stop')" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(aborted.passed).toBe(false);
    expect(aborted.request.sent).toBe(false);
  });

  it("runs standalone flow script steps against the environment", async () => {
    await savePostdogEnvironment({ id: "env-1", name: "local", variables: [{ key: "a", value: "1", enabled: true }] });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });

    const ok = await runPostdogFlowScript({ script: "await $.env.set('b', Number($.env.get('a')) + 1); $.assert($.request === null);" });
    expect(ok.passed).toBe(true);
    const variables = getChromeStorageSnapshot()[POSTDOG_ENVIRONMENTS_KEY][0].variables;
    expect(variables).toEqual(expect.arrayContaining([expect.objectContaining({ key: "b", value: "2" })]));

    const failed = await runPostdogFlowScript({ script: "$.assert($.env.get('missing'), 'missing var')" });
    expect(failed.passed).toBe(false);
    expect(failed.logs[0]).toMatchObject({ level: "error", phase: "script", message: "missing var" });
  });

  it("exports curl with environment variables and query params resolved", async () => {
    await savePostdogEnvironment({
      id: "env-1",
      name: "local",
      variables: [
        { key: "baseUrl", value: "https://api.example.com", enabled: true },
        { key: "token", value: "secret-token", enabled: true, secret: true },
        { key: "name", value: "alice", enabled: true }
      ]
    });
    await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "env-1" });

    const text = await exportPostdogCurl({
      method: "POST",
      url: "{{baseUrl}}/users/{{missing}}",
      headers: [
        { key: "Authorization", value: "Bearer {{token}}", enabled: true },
        { key: "X-Disabled", value: "1", enabled: false }
      ],
      query: [{ key: "q", value: "{{name}}", enabled: true }],
      body: { type: "json", text: "{\n  // comment\n  \"name\": \"{{name}}\"\n}" }
    });

    expect(text).toContain("https://api.example.com/users/{{missing}}?q=alice");
    expect(text).toContain("Authorization: Bearer secret-token");
    expect(text).not.toContain("X-Disabled");
    expect(text).toContain(`--data-raw '{"name":"alice"}'`);
  });
});
