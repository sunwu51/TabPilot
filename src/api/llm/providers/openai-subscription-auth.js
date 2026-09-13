/* global chrome */
import { normalizeStoredModelConfig } from "../core/modelProfiles";

export const OPENAI_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_SUBSCRIPTION_API_URL = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_SUBSCRIPTION_API_TYPE = "openai-subscription";
export const OPENAI_SUBSCRIPTION_ALARM_PREFIX = "openai-subscription-refresh:";

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CREDENTIAL_PREFIX = "openAiSubscriptionCredential:";
const PENDING_PREFIX = "openAiSubscriptionPending:";
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const CODEX_CLIENT_VERSION = "26.903.71938";
const refreshTasks = new Map();

export async function startOpenAiSubscriptionOAuth({ profileId, model }) {
  const normalizedProfileId = String(profileId || "").trim();
  const normalizedModel = String(model || "").trim();
  if (!normalizedProfileId || !normalizedModel) throw new Error("模型不能为空");

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const authParams = {
    response_type: "code",
    client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs"
  };
  const authUrl = `${AUTHORIZE_URL}?${Object.entries(authParams)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")}`;

  const tab = await chrome.tabs.create({ url: authUrl });
  await chrome.storage.session.set({
    [`${PENDING_PREFIX}${state}`]: {
      state,
      verifier,
      profileId: normalizedProfileId,
      model: normalizedModel,
      tabId: tab.id,
      createdAt: Date.now()
    }
  });
  return { state, tabId: tab.id };
}

export async function handleOpenAiSubscriptionNavigation(details) {
  let url;
  try {
    url = new URL(details?.url || "");
  } catch {
    return false;
  }
  if (url.origin !== "http://localhost:1455" || url.pathname !== "/auth/callback") return false;
  const state = url.searchParams.get("state") || "";
  if (!state) return false;
  const pendingKey = `${PENDING_PREFIX}${state}`;
  const stored = await chrome.storage.session.get(pendingKey);
  const pending = stored[pendingKey];
  if (!pending || pending.state !== state || pending.tabId !== details.tabId) return false;

  if (Date.now() - Number(pending.createdAt || 0) > PENDING_TTL_MS) {
    await chrome.storage.session.remove(pendingKey);
    await finishLoginTab(details.tabId, false, "登录已超时，请重试");
    return true;
  }

  await chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL("oauth-complete.html") }).catch(() => {});

  const oauthError = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (oauthError || !code) {
    await chrome.storage.session.remove(pendingKey);
    await finishLoginTab(details.tabId, false, url.searchParams.get("error_description") || oauthError || "登录回调缺少授权码");
    return true;
  }

  try {
    const token = await exchangeToken({
      grant_type: "authorization_code",
      client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier
    });
    const credential = await saveCredential(pending.profileId, token);
    const availableModels = await fetchAvailableModels(credential).catch(() => []);
    const nextCredential = { ...credential, availableModels };
    await chrome.storage.local.set({ [`${CREDENTIAL_PREFIX}${pending.profileId}`]: nextCredential });
    await upsertSubscriptionProfile(pending, nextCredential);
    await chrome.storage.session.remove(pendingKey);
    await finishLoginTab(details.tabId, true);
    Promise.resolve(chrome.runtime.sendMessage({
      type: "openai_subscription_oauth_completed",
      success: true,
      profileId: pending.profileId,
      model: pending.model,
      availableModels
    })).catch(() => {});
  } catch (error) {
    await chrome.storage.session.remove(pendingKey);
    await finishLoginTab(details.tabId, false, error?.message || String(error));
    Promise.resolve(chrome.runtime.sendMessage({
      type: "openai_subscription_oauth_completed",
      success: false,
      profileId: pending.profileId,
      error: error?.message || String(error)
    })).catch(() => {});
  }
  return true;
}

export async function ensureOpenAiSubscriptionAccess(profileId, options = {}) {
  const credential = await getCredential(profileId);
  if (!credential?.accessToken) throw new Error("OpenAI Subscription 登录已失效，请重新登录");
  if (options.force !== true && Number(credential.expiresAt) - Date.now() > REFRESH_EARLY_MS) return credential;
  if (!credential.refreshToken) throw new Error("OpenAI Subscription 缺少 refresh token，请重新登录");
  if (refreshTasks.has(profileId)) return refreshTasks.get(profileId);
  const task = refreshCredential(profileId, credential).finally(() => refreshTasks.delete(profileId));
  refreshTasks.set(profileId, task);
  return task;
}

export async function requestOpenAiSubscriptionAccess(profileId, options = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "openai_subscription_oauth",
    action: "access",
    profileId,
    force: options.force === true
  });
  if (!response?.success) throw new Error(response?.error || "无法读取 OpenAI Subscription 凭据");
  return response.result;
}

export async function listOpenAiSubscriptionModels(credentialId, options = {}) {
  const credential = await ensureOpenAiSubscriptionAccess(credentialId);
  if (options.refresh !== true && Array.isArray(credential.availableModels) && credential.availableModels.length > 0) {
    return credential.availableModels;
  }
  const availableModels = await fetchAvailableModels(credential);
  await chrome.storage.local.set({
    [`${CREDENTIAL_PREFIX}${credentialId}`]: { ...credential, availableModels }
  });
  return availableModels;
}

export async function refreshOpenAiSubscriptionCredential(profileId) {
  return ensureOpenAiSubscriptionAccess(profileId, { force: true });
}

export async function removeOpenAiSubscriptionCredential(profileId) {
  await chrome.storage.local.remove(`${CREDENTIAL_PREFIX}${profileId}`);
  await chrome.alarms?.clear(`${OPENAI_SUBSCRIPTION_ALARM_PREFIX}${profileId}`);
}

async function refreshCredential(profileId, current) {
  const refreshed = await exchangeToken({
    grant_type: "refresh_token",
    client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
    refresh_token: current.refreshToken,
    scope: "openid profile email offline_access"
  });
  return saveCredential(profileId, {
    ...refreshed,
    refresh_token: refreshed.refresh_token || current.refreshToken,
    id_token: refreshed.id_token || current.idToken
  }, current);
}

async function exchangeToken(params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI OAuth token 请求失败 (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

async function saveCredential(profileId, token, previous = {}) {
  const accessPayload = decodeJwtPayload(token.access_token);
  const idPayload = decodeJwtPayload(token.id_token);
  const expiresAt = resolveExpiresAt(token, accessPayload);
  const identity = extractIdentity(accessPayload, idPayload);
  const credential = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    idToken: token.id_token || "",
    tokenType: token.token_type || "Bearer",
    scope: token.scope || "openid profile email offline_access",
    expiresAt,
    obtainedAt: Date.now(),
    accountId: identity.accountId || previous.accountId || "",
    email: identity.email || previous.email || "",
    planType: identity.planType || previous.planType || "",
    ...(Array.isArray(previous.availableModels) ? { availableModels: previous.availableModels } : {})
  };
  if (!credential.accountId) throw new Error("OpenAI OAuth token 中没有可用的 ChatGPT account ID");
  await chrome.storage.local.set({ [`${CREDENTIAL_PREFIX}${profileId}`]: credential });
  if (Number.isFinite(expiresAt)) {
    await chrome.alarms?.clear(`${OPENAI_SUBSCRIPTION_ALARM_PREFIX}${profileId}`);
    await chrome.alarms?.create(`${OPENAI_SUBSCRIPTION_ALARM_PREFIX}${profileId}`, {
      when: Math.max(Date.now() + 1000, expiresAt - REFRESH_EARLY_MS)
    });
  }
  return credential;
}

async function getCredential(profileId) {
  const key = `${CREDENTIAL_PREFIX}${profileId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

async function upsertSubscriptionProfile(pending, credential) {
  const { llmConfig = {} } = await chrome.storage.local.get({ llmConfig: {} });
  const current = normalizeStoredModelConfig(llmConfig);
  const profile = {
    id: pending.profileId,
    name: `OpenAI · ${pending.model}`,
    apiType: OPENAI_SUBSCRIPTION_API_TYPE,
    baseUrl: "",
    apiKey: "",
    model: pending.model,
    nativeWebSearch: true,
    credentialId: pending.profileId,
    accountId: credential.accountId || "",
    email: credential.email || "",
    planType: credential.planType || "",
    requiresApiKey: false
  };
  const exists = current.llmModels.some(item => item.id === profile.id);
  await chrome.storage.local.set({
    llmConfig: normalizeStoredModelConfig({
      ...current,
      llmModels: exists
        ? current.llmModels.map(item => item.id === profile.id ? profile : item)
        : [...current.llmModels, profile],
      activeLlmModelId: current.activeLlmModelId || profile.id
    })
  });
}

async function fetchAvailableModels(credential) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "ChatGPT-Account-Id": credential.accountId,
    originator: "codex_cli_rs"
  };
  const endpoints = [
    `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`,
    "https://chatgpt.com/backend-api/sentinel/chat-requirements"
  ];
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, { headers });
    if (!response.ok) continue;
    const parsed = await response.json();
    const models = normalizeOpenAiSubscriptionModels(parsed);
    if (models.length > 0) return models;
  }
  throw new Error("OpenAI 没有返回可用模型列表");
}

export function normalizeOpenAiSubscriptionModels(payload) {
  const source = payload?.chat_models?.models || payload?.models || payload?.data || payload?.categories || [];
  const flattened = [];
  for (const item of Array.isArray(source) ? source : []) {
    if (Array.isArray(item?.models)) flattened.push(...item.models);
    else flattened.push(item);
  }
  const seen = new Set();
  return flattened.map(item => ({
    id: stringValue(item?.slug),
    name: stringValue(item?.display_name || item?.displayName || item?.name || item?.slug),
    visibility: stringValue(item?.visibility),
    description: stringValue(item?.description)
  })).filter(item => item.id && item.id !== "auto" && item.visibility !== "hidden" && !seen.has(item.id) && seen.add(item.id))
    .map(item => ({ id: item.id, name: item.name, description: item.description }));
}

function extractIdentity(...payloads) {
  const records = payloads.map(payload => ({
    payload,
    auth: payload?.["https://api.openai.com/auth"],
    profile: payload?.["https://api.openai.com/profile"]
  }));
  return {
    accountId: firstString(records.map(item => item.auth?.chatgpt_account_id)),
    email: firstString(records.flatMap(item => [item.profile?.email, item.payload?.email])),
    planType: firstString(records.flatMap(item => [item.auth?.chatgpt_plan_type, item.profile?.chatgpt_plan_type]))
  };
}

function resolveExpiresAt(token, payload) {
  const expiresIn = Number(token.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000;
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) ? exp * 1000 : Date.now() + 60 * 60 * 1000;
}

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(normalized), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(values) {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return "";
}

async function finishLoginTab(tabId, success, message = "") {
  const params = new URLSearchParams({ status: success ? "success" : "error", ...(message ? { message } : {}) });
  await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`oauth-complete.html?${params}`) }).catch(() => {});
}
