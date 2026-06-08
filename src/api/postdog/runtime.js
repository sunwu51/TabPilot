import Sval from "sval";
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
    const text = await fetchResponse.text();
    responsePayload = {
      status: fetchResponse.status,
      statusText: fetchResponse.statusText,
      ok: fetchResponse.ok,
      url: fetchResponse.url,
      headers: Object.fromEntries(fetchResponse.headers.entries()),
      bodyText: text,
      bodyJson: parseJsonMaybe(text)
    };
  } catch (error) {
    responsePayload = {
      error: error?.message || String(error),
      ok: false,
      status: 0,
      statusText: "FETCH_ERROR",
      headers: {},
      bodyText: "",
      bodyJson: null
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
    response: result.response,
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
    body = applyVariables(request.body?.text || "", vars);
    if (request.body?.type === "json" && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }
  return { method, url, headers, body };
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
