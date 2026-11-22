/* global chrome */
import Sval from "sval";
import { exportCurl } from "./curl";
import { normalizeJsonRequestBody, parseJsonWithComments } from "./json";
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
  const folderChain = await getRequestFolderChain(request); // outermost first
  const secretValues = buildSecretValues(env);
  // `failed` is set only when a script throws; console.error / failed $.test do not count.
  const scriptState = { tests: {}, logs: [], failed: false };
  // Flow (编排) scripts wrap the request scripts: folder pre → flow pre → request pre … request post → flow post → folder post.
  const flow = input.flow && typeof input.flow === "object"
    ? { preScript: String(input.flow.preScript || ""), postScript: String(input.flow.postScript || "") }
    : null;
  const mutableRequest = cloneRequest(request);
  const runId = newPostdogId("pdh");
  const createdAt = Date.now();

  // A failing pre script (folder or request) aborts the send: running a request whose
  // setup failed (missing token, bad URL...) is usually worse than not running it.
  let abortReason = "";
  for (const folder of folderChain) {
    const folderPreOk = await runScript(folder.preScript, {
      phase: "folder_pre",
      request: mutableRequest,
      env,
      envVars,
      scriptState
    });
    if (!folderPreOk) {
      abortReason = "Folder pre script failed";
      break;
    }
  }
  if (!abortReason && flow) {
    const flowPreOk = await runScript(flow.preScript, {
      phase: "flow_pre",
      request: mutableRequest,
      env,
      envVars,
      scriptState
    });
    if (!flowPreOk) abortReason = "Flow pre script failed";
  }
  if (!abortReason) {
    const preOk = await runScript(mutableRequest.preScript, {
      phase: "pre",
      request: mutableRequest,
      env,
      envVars,
      scriptState
    });
    if (!preOk) abortReason = "Pre script failed";
  }

  let prepared = { method: String(mutableRequest.method || "GET").toUpperCase(), url: applyVariables(mutableRequest.url, envVars), headers: {}, body: undefined };
  if (!abortReason) {
    try {
      prepared = prepareRequest(mutableRequest, envVars);
    } catch (error) {
      scriptState.logs.push({ level: "error", phase: "prepare", message: `Invalid request: ${error?.message || error}` });
      abortReason = `Invalid request: ${error?.message || error}`;
    }
  }
  const startedAt = performance.now();
  let responsePayload;
  if (abortReason) {
    responsePayload = {
      error: `${abortReason}. The request was not sent; see the Logs tab.`,
      ok: false,
      status: 0,
      statusText: "NOT_SENT",
      headers: {},
      bodyKind: "text",
      bodyText: "",
      bodyJson: null,
      bodySizeBytes: 0,
      bodyTruncated: false,
      bodyNote: ""
    };
  } else try {
    const fetchResponse = await withUserAgentRule(prepared, () => fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      credentials: "include",
      redirect: "follow"
    }));
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

  // Post scripts need a real response; they are skipped when the request was not sent.
  // A failing post script is logged and does not stop the next one.
  if (!abortReason) {
    await runScript(mutableRequest.postScript, {
      phase: "post",
      request: mutableRequest,
      response: responsePayload,
      env,
      envVars,
      scriptState
    });

    if (flow) {
      await runScript(flow.postScript, {
        phase: "flow_post",
        request: mutableRequest,
        response: responsePayload,
        env,
        envVars,
        scriptState
      });
    }

    for (const folder of [...folderChain].reverse()) {
      await runScript(folder.postScript, {
        phase: "folder_post",
        request: mutableRequest,
        response: responsePayload,
        env,
        envVars,
        scriptState
      });
    }
  }

  const result = {
    success: !responsePayload.error,
    runId,
    request: redactSecrets({
      id: request.id,
      name: request.name,
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      body: formatRequestBodySnapshot(mutableRequest, prepared.body, envVars),
      bodyType: mutableRequest.body?.type || "none",
      // what was stored before variables / scripts were applied
      template: buildRequestTemplateSnapshot(request),
      environment: env ? { id: env.id, name: env.name } : null,
      sent: !abortReason
    }, secretValues),
    response: redactSecrets(responsePayload, secretValues),
    durationMs,
    tests: scriptState.tests,
    logs: redactSecrets(scriptState.logs, secretValues),
    scriptFailed: scriptState.logs.some(log => log.level === "error"),
    // Flow pass/fail: the request was sent and got a response, and no script threw.
    // The HTTP status does not matter; scripts throw (e.g. $.assert) to fail a step.
    passed: !responsePayload.error && !scriptState.failed
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

function buildRequestTemplateSnapshot(request) {
  const fields = (request.body?.fields || []).map(item => ({
    key: item.key,
    value: item.kind === "file" ? "" : item.value,
    kind: item.kind || "text",
    fileName: item.fileName || "",
    enabled: item.enabled !== false
  }));
  return {
    method: request.method,
    url: request.url,
    headers: (request.headers || []).map(item => ({ key: item.key, value: item.value, enabled: item.enabled !== false })),
    query: (request.query || []).map(item => ({ key: item.key, value: item.value, enabled: item.enabled !== false })),
    body: { type: request.body?.type || "none", text: request.body?.text || "", fields }
  };
}

const USER_AGENT_RULE_BASE = 1_000_000;
let userAgentRuleSeq = 0;

// Chrome ignores a User-Agent set through fetch(), so apply it at the network layer with a
// short-lived session rule that only matches this exact URL coming from the extension itself.
async function withUserAgentRule(prepared, send) {
  const uaKey = Object.keys(prepared.headers || {}).find(key => key.toLowerCase() === "user-agent");
  const dnr = typeof chrome !== "undefined" ? chrome?.declarativeNetRequest : null;
  if (!uaKey || !dnr?.updateSessionRules) return send();
  const ruleId = USER_AGENT_RULE_BASE + (userAgentRuleSeq = (userAgentRuleSeq + 1) % 100000);
  let installed = false;
  try {
    const target = new URL(prepared.url);
    target.hash = "";
    const regexFilter = `^${target.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    if (regexFilter.length <= 1500) {
      await dnr.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "User-Agent", operation: "set", value: String(prepared.headers[uaKey]) }]
          },
          condition: {
            regexFilter,
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest"]
          }
        }]
      });
      installed = true;
    }
  } catch {
    // Fall back to a plain fetch if the rule cannot be installed.
  }
  try {
    return await send();
  } finally {
    if (installed) {
      try { await dnr.updateSessionRules({ removeRuleIds: [ruleId] }); } catch { /* ignore */ }
    }
  }
}

/** Folders containing the request, outermost first (cycle-safe). */
async function getRequestFolderChain(request) {
  let folderId = String(request?.folderId || "").trim();
  if (!folderId) return [];
  const byId = new Map((await listPostdogFolders()).map(item => [item.id, item]));
  const chain = [];
  const seen = new Set();
  while (folderId && byId.has(folderId) && !seen.has(folderId)) {
    seen.add(folderId);
    const folder = byId.get(folderId);
    chain.unshift(folder);
    folderId = folder.parentId || "";
  }
  return chain;
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
    } else if (request.body?.type === "text" && rawBody && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "text/plain;charset=UTF-8";
    }
  }
  return { method, url, headers, body };
}

function formatRequestBodySnapshot(request, preparedBody, vars) {
  if (request.body?.type !== "multipart") return preparedBody || "";
  const lines = [];
  for (const item of request.body.fields || []) {
    if (item.enabled === false || !item.key) continue;
    if (item.kind === "file") {
      const sizeBytes = base64ToBytes(item.dataBase64 || "").byteLength;
      lines.push(`${applyVariables(item.key, vars)}: [file ${applyVariables(item.fileName || "file", vars)}, ${item.mimeType || "application/octet-stream"}, ${sizeBytes} bytes]`);
    } else {
      lines.push(`${applyVariables(item.key, vars)}: ${applyVariables(item.value, vars)}`);
    }
  }
  return lines.join("\n");
}

function removeHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

function applyVariables(value, vars, options = {}) {
  return String(value ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => {
    const builtin = evaluateBuiltinTemplateFunction(key);
    if (builtin != null) return builtin;
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    return options.keepUnknown ? match : "";
  });
}

/**
 * Resolve {{variables}} from the given map and built-in template functions,
 * merge query params into the URL and strip JSON comments so the request can be
 * exported as a ready-to-run curl command. Scripts are not executed.
 * Unknown variables are kept as {{name}} so they are easy to spot.
 */
export function resolvePostdogRequestForExport(request, vars = {}) {
  const apply = value => applyVariables(value, vars, { keepUnknown: true });
  const method = String(request?.method || "GET").toUpperCase();
  const headers = (request?.headers || [])
    .filter(item => item.enabled !== false && item.key)
    .map(item => ({ key: apply(item.key), value: apply(item.value), enabled: true }));
  let url = apply(request?.url || "");
  const query = (request?.query || [])
    .filter(item => item.enabled !== false && item.key)
    .map(item => [apply(item.key), apply(item.value)]);
  if (query.length) {
    try {
      // Keep unresolved {{vars}} readable instead of percent-encoding them.
      if (url.includes("{{")) throw new Error("unresolved");
      const parsed = new URL(url);
      for (const [key, value] of query) parsed.searchParams.set(key, value);
      url = parsed.toString();
    } catch {
      const search = new URLSearchParams(query).toString();
      url = `${url}${url.includes("?") ? "&" : "?"}${search}`;
    }
  }
  const type = request?.body?.type || "none";
  let body = { type: "none", text: "", fields: [] };
  if (BODY_METHODS.has(method) && type !== "none") {
    if (type === "form" || type === "multipart") {
      body = {
        type,
        text: "",
        fields: (request.body.fields || [])
          .filter(item => item.enabled !== false && item.key)
          .map(item => ({
            ...item,
            key: apply(item.key),
            value: apply(item.value),
            fileName: item.kind === "file" ? apply(item.fileName || "file") : ""
          }))
      };
    } else {
      let text = apply(request.body?.text || "");
      if (type === "json") {
        try {
          text = normalizeJsonRequestBody(text);
        } catch {
          // keep the raw text when it is not valid JSON
        }
      }
      body = { type, text, fields: [] };
    }
  }
  return { ...request, method, url, headers, query: [], body };
}

export async function exportPostdogCurl(request) {
  const env = await getActivePostdogEnvironment();
  return exportCurl(resolvePostdogRequestForExport(request, buildVariableMap(env)));
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

/**
 * Run a standalone flow script step against the active environment (no request / response).
 * Returns { passed, tests, logs, durationMs }.
 */
export async function runPostdogFlowScript(input = {}) {
  const env = await getActivePostdogEnvironment();
  const envVars = buildVariableMap(env);
  const secretValues = buildSecretValues(env);
  const scriptState = { tests: {}, logs: [], failed: false };
  const startedAt = performance.now();
  await runScript(input.script, { phase: "script", request: null, env, envVars, scriptState });
  return {
    passed: !scriptState.failed,
    tests: scriptState.tests,
    logs: redactSecrets(scriptState.logs, secretValues),
    durationMs: Math.round(performance.now() - startedAt)
  };
}

async function runScript(script, context) {
  const source = String(script || "").trim();
  if (!source) return true;
  const api = buildScriptApi(context);
  const consoleApi = buildScriptConsole(context);
  const runtime = new Sval({
    ecmaVer: "latest",
    sourceType: "script",
    sandBox: true
  });
  runtime.import({
    postdog: api,
    $: api,
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
    return true;
  } catch (error) {
    context.scriptState.failed = true;
    context.scriptState.logs.push({
      level: "error",
      phase: context.phase,
      message: `${error?.name && error.name !== "Error" ? `${error.name}: ` : ""}${error?.message || String(error)}`
    });
    return false;
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
  const setOne = async (key, value, options = {}) => {
    if (!envId) throw new Error("No active environment");
    const name = String(key ?? "").trim();
    if (!name) return;
    context.envVars[name] = String(value ?? "");
    await setPostdogEnvironmentVariable(envId, name, value, options);
  };
  const unsetOne = async (key) => {
    if (!envId) throw new Error("No active environment");
    const name = String(key ?? "").trim();
    delete context.envVars[name];
    await unsetPostdogEnvironmentVariable(envId, name);
  };
  const envApi = {
    get: (key) => context.envVars[String(key)] ?? "",
    // set("k", v, options) or set({ k1: v1, k2: v2 }, options)
    set: async (key, value, options = {}) => {
      if (isPlainObject(key)) {
        for (const [name, item] of Object.entries(key)) await setOne(name, item, value || {});
        return;
      }
      await setOne(key, value, options);
    },
    // unset("k") or unset(["k1", "k2"]) or unset("k1", "k2")
    unset: async (...keys) => {
      for (const key of keys.flat()) await unsetOne(key);
    },
    has: (key) => Object.prototype.hasOwnProperty.call(context.envVars, String(key)),
    all: () => ({ ...context.envVars }),
    toJSON: () => ({ ...context.envVars })
  };
  const variablesApi = {
    get: envApi.get,
    set: envApi.set,
    unset: envApi.unset,
    has: envApi.has,
    all: envApi.all,
    toJSON: envApi.toJSON
  };
  const requestApi = !context.request ? null : {
    get method() { return context.request.method; },
    set method(value) { context.request.method = String(value || "GET").toUpperCase(); },
    get url() { return context.request.url; },
    set url(value) { context.request.url = String(value || ""); },
    headers: buildKeyValueApi(() => context.request.headers, list => { context.request.headers = list; }),
    query: buildKeyValueApi(() => context.request.query, list => { context.request.query = list; }),
    body: {
      // set("raw text") | set({ a: 1 }) -> json | set(text, "json")
      set: (value, type) => {
        const isObject = value != null && typeof value === "object";
        const currentType = context.request.body?.type;
        const nextType = type || (isObject ? "json" : currentType && currentType !== "none" ? currentType : "text");
        context.request.body = {
          ...(context.request.body || {}),
          type: nextType,
          text: isObject ? JSON.stringify(value, null, 2) : String(value ?? "")
        };
      },
      get: () => context.request.body?.text || "",
      json: () => {
        try {
          return parseJsonWithComments(context.request.body?.text || "");
        } catch {
          return null;
        }
      }
    }
  };
  if (requestApi) requestApi.params = requestApi.query;
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
    // await $.sleep(1000): pause the script for the given milliseconds.
    sleep: scriptSleep,
    // $.assert(cond, "message"): throw (and so fail the step / abort the send) when cond is falsy.
    assert: (condition, message) => {
      if (!condition) throw new Error(message == null || message === "" ? "Assertion failed" : String(message));
    },
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

function scriptSleep(ms) {
  const delay = Number(ms);
  return new Promise(resolve => setTimeout(resolve, Number.isFinite(delay) && delay > 0 ? delay : 0));
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

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// headers / query helpers:
//   set("k", v) | set({ k1: v1, k2: v2 }), get("k"), has("k"),
//   unset("k") | unset("k1", "k2") | unset(["k1", "k2"]), all()
function buildKeyValueApi(getList, setList) {
  const list = () => {
    let current = getList();
    if (!Array.isArray(current)) {
      current = [];
      setList(current);
    }
    return current;
  };
  const snapshot = () => Object.fromEntries(list().filter(item => item.enabled !== false).map(item => [item.key, item.value]));
  return {
    set: (key, value) => {
      if (isPlainObject(key)) {
        for (const [name, item] of Object.entries(key)) upsertKeyValue(list(), name, item);
        return;
      }
      upsertKeyValue(list(), key, value);
    },
    get: (key) => getKeyValue(list(), key),
    has: (key) => list().some(item => item.key.toLowerCase() === String(key || "").trim().toLowerCase()),
    unset: (...keys) => {
      for (const key of keys.flat()) removeKeyValue(list(), key);
    },
    all: snapshot,
    toJSON: snapshot
  };
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
