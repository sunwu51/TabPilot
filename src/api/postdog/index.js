/* global chrome */

export const POSTDOG_FOLDERS_KEY = "postdogFolders";
export const POSTDOG_REQUESTS_KEY = "postdogRequests";
export const POSTDOG_ENVIRONMENTS_KEY = "postdogEnvironments";
export const POSTDOG_ACTIVE_ENVIRONMENT_KEY = "postdogActiveEnvironmentId";
export const POSTDOG_HISTORY_KEY = "postdogHistory";

const MAX_HISTORY = 100;

export function newPostdogId(prefix) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function normalizeFolder(folder) {
  if (!folder || typeof folder !== "object") return null;
  const id = String(folder.id || "").trim();
  const name = String(folder.name || "").trim();
  if (!id || !name) return null;
  const createdAt = Number(folder.createdAt) || Date.now();
  return {
    id,
    name,
    parentId: String(folder.parentId || "").trim() || null,
    preScript: String(folder.preScript || ""),
    postScript: String(folder.postScript || ""),
    createdAt,
    updatedAt: Number(folder.updatedAt) || createdAt
  };
}

export function normalizeKeyValue(item) {
  if (!item || typeof item !== "object") return null;
  const key = String(item.key || "").trim();
  if (!key) return null;
  return {
    key,
    value: String(item.value ?? ""),
    enabled: item.enabled !== false,
    secret: item.secret === true
  };
}

export function normalizeEnvironment(env) {
  if (!env || typeof env !== "object") return null;
  const id = String(env.id || "").trim();
  const name = String(env.name || "").trim();
  if (!id || !name) return null;
  const createdAt = Number(env.createdAt) || Date.now();
  const variables = Array.isArray(env.variables)
    ? env.variables.map(normalizeKeyValue).filter(Boolean)
    : [];
  return {
    id,
    name,
    variables,
    createdAt,
    updatedAt: Number(env.updatedAt) || createdAt
  };
}

export function normalizeRequest(request) {
  if (!request || typeof request !== "object") return null;
  const id = String(request.id || "").trim();
  const name = String(request.name || "").trim();
  if (!id || !name) return null;
  const createdAt = Number(request.createdAt) || Date.now();
  const method = String(request.method || "GET").trim().toUpperCase() || "GET";
  return {
    id,
    name,
    folderId: String(request.folderId || "").trim() || null,
    method,
    url: String(request.url || "").trim(),
    headers: Array.isArray(request.headers) ? request.headers.map(normalizeKeyValue).filter(Boolean) : [],
    query: Array.isArray(request.query) ? request.query.map(normalizeKeyValue).filter(Boolean) : [],
    body: {
      type: ["none", "json", "text"].includes(request.body?.type) ? request.body.type : "none",
      text: String(request.body?.text ?? "")
    },
    preScript: String(request.preScript || ""),
    postScript: String(request.postScript || ""),
    createdAt,
    updatedAt: Number(request.updatedAt) || createdAt
  };
}

export async function listPostdogFolders() {
  const res = await chrome.storage.local.get({ [POSTDOG_FOLDERS_KEY]: [] });
  const folders = Array.isArray(res[POSTDOG_FOLDERS_KEY]) ? res[POSTDOG_FOLDERS_KEY] : [];
  return folders.map(normalizeFolder).filter(Boolean);
}

export async function savePostdogFolder(folder) {
  const normalized = normalizeFolder({
    ...folder,
    id: folder?.id || newPostdogId("pdf"),
    updatedAt: Date.now()
  });
  if (!normalized) throw new Error("invalid folder");
  const folders = await listPostdogFolders();
  const index = folders.findIndex(item => item.id === normalized.id);
  if (index >= 0) folders[index] = normalized;
  else folders.unshift(normalized);
  await chrome.storage.local.set({ [POSTDOG_FOLDERS_KEY]: folders });
  return normalized;
}

export async function deletePostdogFolder(id) {
  const folderId = String(id || "").trim();
  const folders = await listPostdogFolders();
  const requests = await listPostdogRequests();
  const nextFolders = folders.filter(item => item.id !== folderId);
  const nextRequests = requests.filter(item => item.folderId !== folderId);
  await chrome.storage.local.set({
    [POSTDOG_FOLDERS_KEY]: nextFolders,
    [POSTDOG_REQUESTS_KEY]: nextRequests
  });
  return {
    id: folderId,
    removed: folders.length - nextFolders.length,
    removedRequests: requests.length - nextRequests.length
  };
}

export async function listPostdogRequests() {
  const res = await chrome.storage.local.get({ [POSTDOG_REQUESTS_KEY]: [] });
  const requests = Array.isArray(res[POSTDOG_REQUESTS_KEY]) ? res[POSTDOG_REQUESTS_KEY] : [];
  return requests.map(normalizeRequest).filter(Boolean);
}

export async function getPostdogRequest(id) {
  const requestId = String(id || "").trim();
  const requests = await listPostdogRequests();
  return requests.find(item => item.id === requestId) || null;
}

export async function savePostdogRequest(request) {
  const normalized = normalizeRequest({
    ...request,
    id: request?.id || newPostdogId("pdr"),
    updatedAt: Date.now()
  });
  if (!normalized) throw new Error("invalid request");
  const requests = await listPostdogRequests();
  const index = requests.findIndex(item => item.id === normalized.id);
  if (index >= 0) requests[index] = normalized;
  else requests.unshift(normalized);
  await chrome.storage.local.set({ [POSTDOG_REQUESTS_KEY]: requests });
  return normalized;
}

export async function deletePostdogRequest(id) {
  const requestId = String(id || "").trim();
  const requests = await listPostdogRequests();
  const next = requests.filter(item => item.id !== requestId);
  await chrome.storage.local.set({ [POSTDOG_REQUESTS_KEY]: next });
  return { id: requestId, removed: requests.length - next.length };
}

export async function listPostdogEnvironments() {
  const res = await chrome.storage.local.get({ [POSTDOG_ENVIRONMENTS_KEY]: [] });
  const environments = Array.isArray(res[POSTDOG_ENVIRONMENTS_KEY]) ? res[POSTDOG_ENVIRONMENTS_KEY] : [];
  return environments.map(normalizeEnvironment).filter(Boolean);
}

export async function getActivePostdogEnvironment() {
  const res = await chrome.storage.local.get({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: "" });
  const envs = await listPostdogEnvironments();
  return envs.find(item => item.id === res[POSTDOG_ACTIVE_ENVIRONMENT_KEY]) || envs[0] || null;
}

export async function savePostdogEnvironment(env) {
  const normalized = normalizeEnvironment({
    ...env,
    id: env?.id || newPostdogId("pde"),
    updatedAt: Date.now()
  });
  if (!normalized) throw new Error("invalid environment");
  const envs = await listPostdogEnvironments();
  const index = envs.findIndex(item => item.id === normalized.id);
  if (index >= 0) envs[index] = normalized;
  else envs.unshift(normalized);
  const patch = { [POSTDOG_ENVIRONMENTS_KEY]: envs };
  const active = await getActivePostdogEnvironment();
  if (!active) patch[POSTDOG_ACTIVE_ENVIRONMENT_KEY] = normalized.id;
  await chrome.storage.local.set(patch);
  return normalized;
}

export async function deletePostdogEnvironment(id) {
  const envId = String(id || "").trim();
  const envs = await listPostdogEnvironments();
  const next = envs.filter(item => item.id !== envId);
  const active = await getActivePostdogEnvironment();
  const patch = { [POSTDOG_ENVIRONMENTS_KEY]: next };
  if (active?.id === envId) patch[POSTDOG_ACTIVE_ENVIRONMENT_KEY] = next[0]?.id || "";
  await chrome.storage.local.set(patch);
  return { id: envId, removed: envs.length - next.length };
}

export async function setActivePostdogEnvironment(id) {
  const envId = String(id || "").trim();
  const envs = await listPostdogEnvironments();
  if (envId && !envs.some(item => item.id === envId)) throw new Error(`environment not found: ${envId}`);
  await chrome.storage.local.set({ [POSTDOG_ACTIVE_ENVIRONMENT_KEY]: envId });
  return { id: envId };
}

export async function setPostdogEnvironmentVariable(envId, key, value, options = {}) {
  const id = String(envId || "").trim();
  const name = String(key || "").trim();
  if (!id || !name) throw new Error("environment id and variable key are required");
  const envs = await listPostdogEnvironments();
  const index = envs.findIndex(item => item.id === id);
  if (index < 0) throw new Error(`environment not found: ${id}`);
  const env = envs[index];
  const variables = [...env.variables];
  const varIndex = variables.findIndex(item => item.key === name);
  const nextVar = {
    key: name,
    value: String(value ?? ""),
    enabled: options.enabled !== false,
    secret: options.secret === true || variables[varIndex]?.secret === true
  };
  if (varIndex >= 0) variables[varIndex] = nextVar;
  else variables.push(nextVar);
  envs[index] = { ...env, variables, updatedAt: Date.now() };
  await chrome.storage.local.set({ [POSTDOG_ENVIRONMENTS_KEY]: envs });
  return envs[index];
}

export async function unsetPostdogEnvironmentVariable(envId, key) {
  const id = String(envId || "").trim();
  const name = String(key || "").trim();
  const envs = await listPostdogEnvironments();
  const index = envs.findIndex(item => item.id === id);
  if (index < 0) throw new Error(`environment not found: ${id}`);
  const env = envs[index];
  envs[index] = {
    ...env,
    variables: env.variables.filter(item => item.key !== name),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [POSTDOG_ENVIRONMENTS_KEY]: envs });
  return envs[index];
}

export async function appendPostdogHistory(entry) {
  const res = await chrome.storage.local.get({ [POSTDOG_HISTORY_KEY]: [] });
  const history = Array.isArray(res[POSTDOG_HISTORY_KEY]) ? res[POSTDOG_HISTORY_KEY] : [];
  const runId = String(entry?.runId || entry?.id || newPostdogId("pdh"));
  const next = [{ ...entry, id: runId, runId, createdAt: Number(entry?.createdAt) || Date.now() }, ...history]
    .slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [POSTDOG_HISTORY_KEY]: next });
  return next[0];
}

export async function listPostdogHistory() {
  const res = await chrome.storage.local.get({ [POSTDOG_HISTORY_KEY]: [] });
  return Array.isArray(res[POSTDOG_HISTORY_KEY]) ? res[POSTDOG_HISTORY_KEY] : [];
}

export async function listPostdogHistorySummaries(requestId = "") {
  const targetRequestId = String(requestId || "").trim();
  const history = await listPostdogHistory();
  return history
    .filter(item => !targetRequestId || item.requestId === targetRequestId)
    .map(item => ({
      runId: item.runId || item.id,
      requestId: item.requestId,
      requestName: item.requestName,
      createdAt: item.createdAt,
      method: item.method,
      url: item.url,
      status: item.status,
      ok: item.ok,
      durationMs: item.durationMs
    }));
}

export async function getPostdogHistoryRun(runId) {
  const id = String(runId || "").trim();
  const history = await listPostdogHistory();
  return history.find(item => item.runId === id || item.id === id) || null;
}

export function serializePostdogRequestForAi(request) {
  if (!request) return null;
  return {
    id: request.id,
    name: request.name,
    folderId: request.folderId,
    method: request.method,
    url: request.url,
    headers: request.headers,
    query: request.query,
    body: request.body,
    hasPreScript: !!request.preScript.trim(),
    hasPostScript: !!request.postScript.trim()
  };
}

export function serializePostdogEnvironmentForAi(env) {
  if (!env) return null;
  return {
    id: env.id,
    name: env.name,
    variables: env.variables.map(item => ({
      key: item.key,
      value: item.secret ? "***" : item.value,
      enabled: item.enabled,
      secret: item.secret
    }))
  };
}
