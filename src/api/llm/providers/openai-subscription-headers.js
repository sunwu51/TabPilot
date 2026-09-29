/* global chrome */

// Keep the Codex identity paired when updating the client version.
export const CODEX_SUBSCRIPTION_VERSION = "0.157.1";
export const CODEX_SUBSCRIPTION_ORIGINATOR = "codex_cli_rs";
export const CODEX_SUBSCRIPTION_USER_AGENT = `${CODEX_SUBSCRIPTION_ORIGINATOR}/${CODEX_SUBSCRIPTION_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`;

const USER_AGENT_RULE_ID = 1571;
let userAgentRuleTask;

// Chrome strips User-Agent from fetch(), so set it at the network layer for this extension's Codex requests.
export async function ensureCodexSubscriptionUserAgent() {
  if (!chrome?.declarativeNetRequest?.updateSessionRules) return;
  if (!userAgentRuleTask) {
    userAgentRuleTask = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [USER_AGENT_RULE_ID],
      addRules: [{
        id: USER_AGENT_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "User-Agent", operation: "set", value: CODEX_SUBSCRIPTION_USER_AGENT }]
        },
        condition: {
          urlFilter: "|https://chatgpt.com/backend-api/codex/",
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest"]
        }
      }]
    }).catch(error => {
      userAgentRuleTask = null;
      throw error;
    });
  }
  await userAgentRuleTask;
}

export function buildCodexSubscriptionHeaders(credential, body, accountId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: body?.stream === true ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    ...(credential.accountId || accountId ? { "ChatGPT-Account-Id": credential.accountId || accountId } : {}),
    originator: CODEX_SUBSCRIPTION_ORIGINATOR,
    "User-Agent": CODEX_SUBSCRIPTION_USER_AGENT,
    version: CODEX_SUBSCRIPTION_VERSION,
    "x-client-request-id": crypto.randomUUID()
  };

  const cacheKey = typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key.trim() : "";
  if (cacheKey) {
    headers.session_id = cacheKey;
    headers.conversation_id = cacheKey;
  }

  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (model && !/[;=\r\n]/.test(model)) {
    const tiers = { priority: "priority", fast: "priority", flex: "flex", ultrafast: "ultrafast" };
    const tier = typeof body.service_tier === "string" ? tiers[body.service_tier.toLowerCase()] : undefined;
    headers["x-codex-routing-hint"] = tier ? `model=${model};tier=${tier}` : `model=${model}`;
  }
  return headers;
}
