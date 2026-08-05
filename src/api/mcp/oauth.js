/* global chrome */
const TOKEN_KEY_PREFIX = "mcpOAuth:";
const PENDING_KEY_PREFIX = "mcpOAuthPending:";
const CLIENT_KEY_PREFIX = "mcpOAuthClient:";
export const MCP_OAUTH_ALARM_PREFIX = "mcp-oauth-refresh:";
const OAUTH_ALARM_SERVER_PREFIX = "mcpOAuthAlarmServer:";

function getRedirectUri() {
  if (!globalThis.chrome?.identity?.getRedirectURL) {
    throw new Error("Chrome identity API is unavailable; OAuth cannot be completed");
  }
  return chrome.identity.getRedirectURL("mcp-oauth");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`OAuth discovery failed (${response.status}) at ${url}`);
  return response.json();
}

function getOAuthTokenKey(serverUrl) {
  return `${TOKEN_KEY_PREFIX}${serverUrl}`;
}

function getOAuthClientKey(serverUrl) {
  return `${CLIENT_KEY_PREFIX}${serverUrl}`;
}

function getOAuthAlarmId(serverUrl) {
  let hash = 2166136261;
  for (let i = 0; i < serverUrl.length; i += 1) {
    hash ^= serverUrl.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${MCP_OAUTH_ALARM_PREFIX}${(hash >>> 0).toString(36)}`;
}

async function scheduleTokenRefresh(serverUrl, expiresAt) {
  if (!chrome.alarms?.create || !Number.isFinite(expiresAt)) return;
  const alarmName = getOAuthAlarmId(serverUrl);
  await chrome.storage.local.set({ [`${OAUTH_ALARM_SERVER_PREFIX}${alarmName}`]: serverUrl });
  await chrome.alarms.clear(alarmName);
  await chrome.alarms.create(alarmName, { when: Math.max(Date.now() + 1000, expiresAt - 60 * 60 * 1000) });
}

export async function getOAuthServerUrlForAlarm(alarmName) {
  const result = await chrome.storage.local.get(`${OAUTH_ALARM_SERVER_PREFIX}${alarmName}`);
  return result[`${OAUTH_ALARM_SERVER_PREFIX}${alarmName}`] || "";
}

async function getStoredToken(serverUrl) {
  const result = await chrome.storage.local.get(getOAuthTokenKey(serverUrl));
  return result[getOAuthTokenKey(serverUrl)] || null;
}

async function saveToken(serverUrl, token) {
  const normalized = { ...token };
  if (normalized.expires_at === undefined && normalized.expires_in !== undefined) {
    const expiresIn = Number(normalized.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn >= 0) normalized.expires_at = Date.now() + expiresIn * 1000;
  }
  await chrome.storage.local.set({ [getOAuthTokenKey(serverUrl)]: normalized });
  void scheduleTokenRefresh(serverUrl, normalized.expires_at);
  return normalized;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function parseWwwAuthenticate(value) {
  const match = String(value || "").match(/resource_metadata="([^"]+)"/i);
  return match?.[1] || "";
}

async function discover(serverUrl, resourceMetadataUrl = "") {
  const server = new URL(serverUrl);
  const resourceUrl = resourceMetadataUrl || `${server.origin}/.well-known/oauth-protected-resource${server.pathname}`;
  const resource = await fetchJson(resourceUrl);
  const issuer = resource.authorization_servers?.[0] || resource.issuer;
  if (!issuer) throw new Error("OAuth protected resource metadata has no authorization server");
  const auth = new URL(issuer);
  const metadataUrls = [
    `${auth.origin}/.well-known/oauth-authorization-server${auth.pathname}`,
    `${auth.origin}/.well-known/openid-configuration${auth.pathname}`
  ];
  let authorizationServer;
  for (const url of metadataUrls) {
    try { authorizationServer = await fetchJson(url); break; } catch (_) { /* try the next standard location */ }
  }
  if (!authorizationServer?.authorization_endpoint || !authorizationServer.token_endpoint) {
    throw new Error("OAuth authorization server metadata is incomplete");
  }
  return { resource, authorizationServer };
}

async function registerClient(metadata, redirectUri) {
  if (!metadata.registration_endpoint) return null;
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "TabPilot",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  if (!response.ok) throw new Error(`OAuth client registration failed (${response.status})`);
  return response.json();
}

function launchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

export async function authorizeMcpServer(serverUrl, resourceMetadataUrl = "") {
  const redirectUri = getRedirectUri();
  const { resource, authorizationServer } = await discover(serverUrl, resourceMetadataUrl);
  const client = await registerClient(authorizationServer, redirectUri);
  if (!client?.client_id && !authorizationServer.client_id) {
    throw new Error("OAuth server does not support dynamic client registration");
  }
  const clientId = client?.client_id || authorizationServer.client_id;
  await chrome.storage.local.set({ [getOAuthClientKey(serverUrl)]: {
    clientId,
    tokenEndpoint: authorizationServer.token_endpoint
  } });
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(await sha256(verifier));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const pendingKey = `${PENDING_KEY_PREFIX}${serverUrl}`;
  await chrome.storage.local.set({ [pendingKey]: { state, verifier, redirectUri, clientId, tokenEndpoint: authorizationServer.token_endpoint } });
  const authorizationUrl = new URL(authorizationServer.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(resource.resource ? { resource: resource.resource } : {})
  });
  const callbackUrl = new URL(await launchWebAuthFlow(authorizationUrl.toString()));
  if (callbackUrl.searchParams.get("state") !== state) throw new Error("OAuth state validation failed");
  if (callbackUrl.searchParams.get("error")) throw new Error(callbackUrl.searchParams.get("error_description") || callbackUrl.searchParams.get("error"));
  const response = await fetch(authorizationServer.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callbackUrl.searchParams.get("code") || "",
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier
    })
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status})`);
  const token = await saveToken(serverUrl, await response.json());
  await chrome.storage.local.remove(pendingKey);
  return token;
}

export async function authorizeMcpServerFromServiceWorker(serverUrl, resourceMetadataUrl = "") {
  return authorizeMcpServer(serverUrl, resourceMetadataUrl);
}

export async function refreshMcpServerToken(serverUrl) {
  const [{ [getOAuthTokenKey(serverUrl)]: token }, { [getOAuthClientKey(serverUrl)]: client }] = await Promise.all([
    chrome.storage.local.get(getOAuthTokenKey(serverUrl)),
    chrome.storage.local.get(getOAuthClientKey(serverUrl))
  ]);
  if (!token?.refresh_token || !client?.clientId || !client?.tokenEndpoint) {
    throw new Error("No refresh token is available");
  }
  const response = await fetch(client.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: client.clientId
    })
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed (${response.status})`);
  const refreshed = await response.json();
  const nextToken = { ...token, ...refreshed };
  if (refreshed.expires_in !== undefined) delete nextToken.expires_at;
  return saveToken(serverUrl, nextToken);
}

export async function getMcpAuthorization(serverUrl, wwwAuthenticate = "") {
  const stored = await getStoredToken(serverUrl);
  if (stored?.access_token) return stored;
  return authorizeMcpServer(serverUrl, parseWwwAuthenticate(wwwAuthenticate));
}

export function buildOAuthHeaders(headers, token) {
  return { ...(headers || {}), Authorization: `Bearer ${token.access_token}` };
}
