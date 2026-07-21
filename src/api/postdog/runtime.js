import Sval from "sval";
import { normalizeJsonRequestBody } from "./json";
import {
  appendPostdogHistory,
  getActivePostdogEnvironment,
  getPostdogRequest,
  listPostdogFolders,
  newPostdogId,
  savePostdogRequest,
  setPostdogEnvironmentVariable,
  unsetPostdogEnvironmentVariable
} from "./index";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_TEXT_RESPONSE_BYTES = 1024 * 1024;
const MAX_STREAM_PREVIEW_BYTES = 64 * 1024;
const STREAM_READ_TIMEOUT_MS = 5000;
const MAX_DOWNLOAD_RESPONSE_BYTES = 25 * 1024 * 1024;

export async function runPostdogRequest(input = {}) {
  const stored = input.id ? await getPostdogRequest(input.id) : null;
  const request = stored || await savePostdogRequest(input.request || {});
  if (!request?.url) return { success: false, error: "request url is required" };

  const env = await getActivePostdogEnvironment();
  const envVars = buildVariableMap(env);
  const folder = await getRequestFolder(request);
  const secretValues = buildSecretValues(env);
  const scriptState = { tests: {}, logs: [] };
  const mutableRequest = cloneRequest(request);
  const runId = newPostdogId("pdh");
  const createdAt = Date.now();

  await runScript(folder?.preScript, {
    phase: "folder_pre",
    request: mutableRequest,
    env,
    envVars,
    scriptState
  });

  await runScript(mutableRequest.preScript, {
    phase: "pre",
    request: mutableRequest,
    env,
    envVars,
    scriptState
  });

  const prepared = prepareRequest(mutableRequest, envVars);
  const startedAt = performance.now();
  let responsePayload;
  try {
    const fetchResponse = await fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      credentials: "include",
      redirect: "follow"
    });
    const body = await readPostdogResponseBody(fetchResponse);
    responsePayload = {
      status: fetchResponse.status,
      statusText: fetchResponse.statusText,
      ok: fetchResponse.ok,
      url: fetchResponse.url,
      headers: Object.fromEntries(fetchResponse.headers.entries()),
      bodyKind: body.kind,
      bodyText: body.text,
      bodyJson: body.json,
      bodySizeBytes: body.sizeBytes,
      bodyTruncated: body.truncated,
      bodyNote: body.note,
      download: body.download
    };
  } catch (error) {
    responsePayload = {
      error: error?.message || String(error),
      ok: false,
      status: 0,
      statusText: "FETCH_ERROR",
      headers: {},
      bodyKind: "text",
      bodyText: "",
      bodyJson: null,
      bodySizeBytes: 0,
      bodyTruncated: false,
      bodyNote: ""
    };
  }
  const durationMs = Math.round(performance.now() - startedAt);

  await runScript(mutableRequest.postScript, {
    phase: "post",
    request: mutableRequest,
    response: responsePayload,
    env,
    envVars,
    scriptState
  });

  await runScript(folder?.postScript, {
    phase: "folder_post",
    request: mutableRequest,
    response: responsePayload,
    env,
    envVars,
    scriptState
  });

  const result = {
    success: !responsePayload.error,
    runId,
    request: redactSecrets({
      id: request.id,
      name: request.name,
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      body: prepared.body || ""
    }, secretValues),
    response: redactSecrets(responsePayload, secretValues),
    durationMs,
    tests: scriptState.tests,
    logs: redactSecrets(scriptState.logs, secretValues)
  };

  const historyResponse = { ...result.response };
  delete historyResponse.download;
  const historyRun = await appendPostdogHistory({
    runId,
    createdAt,
    requestId: request.id,
    requestName: request.name,
    method: prepared.method,
    url: redactSecrets(prepared.url, secretValues),
    status: responsePayload.status,
    ok: responsePayload.ok,
    durationMs,
    request: result.request,
    response: historyResponse,
    tests: result.tests,
    logs: result.logs
  });

  return { ...result, runId: historyRun.runId };
}

async function getRequestFolder(request) {
  const folderId = String(request?.folderId || "").trim();
  if (!folderId) return null;
  const folders = await listPostdogFolders();
  return folders.find(item => item.id === folderId) || null;
}

function buildVariableMap(env) {
  const out = {};
  for (const item of env?.variables || []) {
    if (item.enabled === false) continue;
    out[item.key] = item.value;
  }
  return out;
}

function buildSecretValues(env) {
  return (env?.variables || [])
    .filter(item => item.secret && item.value)
    .map(item => String(item.value));
}

function cloneRequest(request) {
  return JSON.parse(JSON.stringify(request));
}

function prepareRequest(request, vars) {
  const method = String(request.method || "GET").toUpperCase();
  const headers = {};
  for (const item of request.headers || []) {
    if (item.enabled === false || !item.key) continue;
    headers[item.key] = applyVariables(item.value, vars);
  }
  let url = applyVariables(request.url, vars);
  const query = (request.query || [])
    .filter(item => item.enabled !== false && item.key)
    .map(item => [applyVariables(item.key, vars), applyVariables(item.value, vars)]);
  if (query.length) {
    const parsed = new URL(url);
    for (const [key, value] of query) parsed.searchParams.set(key, value);
    url = parsed.toString();
  }
  let body;
  if (BODY_METHODS.has(method) && request.body?.type !== "none") {
    if (request.body?.type === "form") {
      const params = new URLSearchParams();
      for (const item of request.body.fields || []) {
        if (item.enabled === false || !item.key) continue;
        params.append(applyVariables(item.key, vars), applyVariables(item.value, vars));
      }
      body = params.toString();
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
      return { method, url, headers, body };
    }
    if (request.body?.type === "multipart") {
      const form = new FormData();
      for (const item of request.body.fields || []) {
        if (item.enabled === false || !item.key) continue;
        const key = applyVariables(item.key, vars);
        if (item.kind === "file") {
          const bytes = base64ToBytes(item.dataBase64 || "");
          form.append(key, new Blob([bytes], { type: item.mimeType || "application/octet-stream" }), applyVariables(item.fileName || "file", vars));
        } else {
          form.append(key, applyVariables(item.value, vars));
        }
      }
      body = form;
      removeHeader(headers, "content-type");
      return { method, url, headers, body };
    }
    const rawBody = applyVariables(request.body?.text || "", vars);
    body = request.body?.type === "json" ? normalizeJsonRequestBody(rawBody) : rawBody;
    if (request.body?.type === "json" && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }
  return { method, url, headers, body };
}

function removeHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

function applyVariables(value, vars) {
  return String(value ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
    const builtin = evaluateBuiltinTemplateFunction(key);
    if (builtin != null) return builtin;
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : "";
  });
}

function evaluateBuiltinTemplateFunction(key) {
  const normalized = String(key || "").trim().replace(/^\$/, "").toLowerCase();
  if (normalized === "guid()" || normalized === "uuid()") return createGuid();
  if (normalized === "now()") return new Date().toISOString();
  if (normalized === "timestamp()") return String(Date.now());
  return null;
}

function createGuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ch => {
    const rand = Math.floor(Math.random() * 16);
    const value = ch === "x" ? rand : ((rand & 0x3) | 0x8);
    return value.toString(16);
  });
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === lower);
}

async function readPostdogResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (isBinaryResponse(contentType, contentDisposition)) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const downloadable = bytes.byteLength <= MAX_DOWNLOAD_RESPONSE_BYTES;
    return {
      kind: "binary",
      text: "",
      json: null,
      sizeBytes: bytes.byteLength || contentLength,
      truncated: false,
      note: downloadable ? "文件响应已就绪，可直接下载。" : "文件超过 25 MB，未保留下载内容。",
      download: downloadable ? {
        fileName: getDownloadFileName(contentDisposition, response.url, contentType),
        mimeType: normalizeContentType(contentType) || "application/octet-stream",
        dataBase64: bytesToBase64(bytes)
      } : null
    };
  }

  const stream = isStreamResponse(contentType);
  const limit = stream ? MAX_STREAM_PREVIEW_BYTES : MAX_TEXT_RESPONSE_BYTES;
  const result = await readResponseTextPreview(response, {
    limitBytes: limit,
    timeoutMs: stream ? STREAM_READ_TIMEOUT_MS : 0
  });
  const truncated = result.truncated || result.timedOut;
  const text = result.text;
  return {
    kind: stream ? "stream" : "text",
    text,
    json: parseJsonMaybe(text),
    sizeBytes: result.sizeBytes,
    truncated,
    note: buildBodyNote({
      kind: stream ? "stream" : "text",
      truncated,
      timedOut: result.timedOut,
      limitBytes: limit,
      sizeBytes: result.sizeBytes
    })
  };
}

function getDownloadFileName(contentDisposition, responseUrl, contentType) {
  const disposition = String(contentDisposition || "");
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1].replace(/^"|"$/g, "")); } catch { /* use fallback */ }
  }
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  if (plain) return (plain[1] || plain[2]).trim();
  try {
    const name = new URL(responseUrl || "").pathname.split("/").filter(Boolean).pop();
    if (name) return decodeURIComponent(name);
  } catch { /* use fallback */ }
  const extension = normalizeContentType(contentType).split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "bin";
  return `download.${extension}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isBinaryResponse(contentType, contentDisposition) {
  const type = normalizeContentType(contentType);
  const disposition = String(contentDisposition || "").toLowerCase();
  if (disposition.includes("attachment")) return true;
  if (!type) return false;
  if (isStreamResponse(type) || isTextualResponse(type)) return false;
  return true;
}

function isStreamResponse(contentType) {
  const type = normalizeContentType(contentType);
  return type === "text/event-stream" ||
    type === "application/x-ndjson" ||
    type === "application/stream+json" ||
    type.includes("stream");
}

function isTextualResponse(contentType) {
  const type = normalizeContentType(contentType);
  return type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/javascript" ||
    type === "application/x-javascript" ||
    type === "application/x-www-form-urlencoded";
}

function normalizeContentType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

async function readResponseTextPreview(response, { limitBytes, timeoutMs }) {
  if (!response.body?.getReader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    const truncated = bytes.length > limitBytes;
    const clipped = truncated ? bytes.slice(0, limitBytes) : bytes;
    return {
      text: new TextDecoder().decode(clipped),
      sizeBytes: bytes.length,
      truncated,
      timedOut: false
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let sizeBytes = 0;
  let storedBytes = 0;
  let truncated = false;
  let timedOut = false;
  try {
    let reading = true;
    while (reading) {
      const read = timeoutMs > 0 ? await readWithTimeout(reader, timeoutMs) : await reader.read();
      if (read.timedOut) {
        timedOut = true;
        break;
      }
      if (read.done) {
        reading = false;
        continue;
      }
      const chunk = normalizeChunk(read.value);
      sizeBytes += chunk.byteLength;
      if (storedBytes < limitBytes) {
        const remaining = limitBytes - storedBytes;
        const kept = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
        chunks.push(kept);
        storedBytes += kept.byteLength;
      }
      if (storedBytes >= limitBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated || timedOut) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation failures from already closed streams.
      }
    }
  }
  return {
    text: new TextDecoder().decode(concatUint8Arrays(chunks, storedBytes)),
    sizeBytes,
    truncated,
    timedOut
  };
}

async function readWithTimeout(reader, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChunk(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value);
  return new TextEncoder().encode(String(value ?? ""));
}

function concatUint8Arrays(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseContentLength(value) {
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function buildBodyNote({ kind, truncated, timedOut, limitBytes, sizeBytes }) {
  if (kind === "stream") {
    if (timedOut) return `流式响应已读取 ${formatBytes(sizeBytes)} 预览，因超过 ${Math.round(STREAM_READ_TIMEOUT_MS / 1000)} 秒未结束而停止。`;
    if (truncated) return `流式响应只展示前 ${formatBytes(limitBytes)} 预览。`;
    return "流式响应已作为预览展示。";
  }
  if (truncated) return `响应 body 超过 ${formatBytes(limitBytes)}，这里只展示前半部分。`;
  return "";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / 1024 / 1024)} MB`;
}

async function runScript(script, context) {
  const source = String(script || "").trim();
  if (!source) return;
  const api = buildScriptApi(context);
  const consoleApi = buildScriptConsole(context);
  const runtime = new Sval({
    ecmaVer: "latest",
    sourceType: "script",
    sandBox: true
  });
  runtime.import({
    postdog: api,
    request: api.request,
    response: api.response,
    env: api.env,
    environment: api.env,
    variables: api.variables,
    guid: createGuid,
    uuid: createGuid,
    now: () => new Date().toISOString(),
    timestamp: () => Date.now(),
    console: consoleApi
  });
  try {
    runtime.run(`${SCRIPT_GUARDS}\nexports.__postdogPromise = (async () => {\n${source}\n})();`);
    await runtime.exports.__postdogPromise;
  } catch (error) {
    context.scriptState.logs.push({
      level: "error",
      phase: context.phase,
      message: error?.message || String(error)
    });
    if (context.phase === "pre") throw error;
  }
}

const SCRIPT_GUARDS = [
  "Object.defineProperty(globalThis, 'chrome', {",
  "  value: undefined,",
  "  writable: false,",
  "  configurable: false",
  "});"
].join("\n");

function buildScriptApi(context) {
  const envId = context.env?.id;
  const envApi = {
    get: (key) => context.envVars[String(key)] ?? "",
    set: async (key, value, options = {}) => {
      if (!envId) throw new Error("No active environment");
      context.envVars[String(key)] = String(value ?? "");
      await setPostdogEnvironmentVariable(envId, key, value, options);
    },
    unset: async (key) => {
      if (!envId) throw new Error("No active environment");
      delete context.envVars[String(key)];
      await unsetPostdogEnvironmentVariable(envId, key);
    },
    all: () => ({ ...context.envVars }),
    toJSON: () => ({ ...context.envVars })
  };
  const variablesApi = {
    get: envApi.get,
    set: envApi.set,
    unset: envApi.unset,
    all: envApi.all,
    toJSON: envApi.toJSON
  };
  const requestApi = {
    get method() { return context.request.method; },
    set method(value) { context.request.method = String(value || "GET").toUpperCase(); },
    get url() { return context.request.url; },
    set url(value) { context.request.url = String(value || ""); },
    headers: {
      set: (key, value) => upsertKeyValue(context.request.headers, key, value),
      get: (key) => getKeyValue(context.request.headers, key),
      unset: (key) => removeKeyValue(context.request.headers, key)
    },
    body: {
      set: (value, type = "text") => {
        context.request.body = { type, text: String(value ?? "") };
      },
      get: () => context.request.body?.text || ""
    }
  };
  const responseApi = context.response ? {
    status: context.response.status,
    ok: context.response.ok,
    headers: context.response.headers,
    text: () => context.response.bodyText,
    json: () => context.response.bodyJson
  } : null;
  return {
    guid: createGuid,
    uuid: createGuid,
    now: () => new Date().toISOString(),
    timestamp: () => Date.now(),
    env: envApi,
    environment: envApi,
    variables: variablesApi,
    request: requestApi,
    response: responseApi,
    test: (name, passed) => {
      context.scriptState.tests[String(name)] = !!passed;
    },
    tests: {
      set: (name, passed) => {
        context.scriptState.tests[String(name)] = !!passed;
      }
    },
    log: (...args) => {
      context.scriptState.logs.push({ level: "info", phase: context.phase, message: args.map(formatScriptLogArg).join(" ") });
    }
  };
}

function buildScriptConsole(context) {
  const write = (level, args) => {
    context.scriptState.logs.push({
      level,
      phase: context.phase,
      message: args.map(formatScriptLogArg).join(" ")
    });
  };
  return {
    log: (...args) => write("info", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args)
  };
}

function formatScriptLogArg(value) {
  if (typeof value === "string") return value;
  if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function") return "[Function]";
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall through to String for circular or sandbox-wrapped values.
  }
  try {
    return String(value);
  } catch {
    return "[Unserializable]";
  }
}

function upsertKeyValue(list, key, value) {
  const name = String(key || "").trim();
  if (!name) return;
  const index = list.findIndex(item => item.key.toLowerCase() === name.toLowerCase());
  const next = { key: name, value: String(value ?? ""), enabled: true };
  if (index >= 0) list[index] = next;
  else list.push(next);
}

function getKeyValue(list, key) {
  const name = String(key || "").trim().toLowerCase();
  return list.find(item => item.key.toLowerCase() === name)?.value || "";
}

function removeKeyValue(list, key) {
  const name = String(key || "").trim().toLowerCase();
  const index = list.findIndex(item => item.key.toLowerCase() === name);
  if (index >= 0) list.splice(index, 1);
}

function parseJsonMaybe(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function redactSecrets(value, secrets) {
  if (!secrets.length) return value;
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join("***");
  }
  return JSON.parse(text);
}
