/* global chrome */
import { describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot } from "../../../../test/setup";
import {
  handleOpenAiSubscriptionNavigation,
  normalizeOpenAiSubscriptionModels,
  startOpenAiSubscriptionOAuth
} from "./openai-subscription-auth";

function jwt(payload) {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${encoded}.signature`;
}

describe("OpenAI Subscription OAuth", () => {
  it("normalizes direct and categorized Codex model responses", () => {
    expect(normalizeOpenAiSubscriptionModels({
      models: [
        { slug: "gpt-5.5", id: "gpt-5.5-wm", display_name: "GPT-5.5" },
        { name: "Codex", models: [
          { slug: "gpt-5.6-codex", display_name: "GPT-5.6 Codex" },
          { slug: "gpt-5.5", display_name: "Duplicate" },
          { slug: "auto", display_name: "Auto" },
          { slug: "internal-model", visibility: "hidden" },
          { id: "gpt-5.6-luna-wm", display_name: "Non-Codex fallback entry" }
        ] }
      ]
    })).toEqual([
      { id: "gpt-5.5", name: "GPT-5.5", description: "" },
      { id: "gpt-5.6-codex", name: "GPT-5.6 Codex", description: "" }
    ]);
  });

  it("ignores localhost callbacks that do not belong to this extension", async () => {
    chrome.storage.session = chrome.storage.local;

    await expect(handleOpenAiSubscriptionNavigation({
      tabId: 99,
      url: "http://localhost:1455/auth/callback?code=foreign&state=foreign"
    })).resolves.toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("exchanges its PKCE callback and stores credentials outside llmConfig", async () => {
    chrome.storage.session = chrome.storage.local;
    const accessToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_plan_type: "plus"
      },
      "https://api.openai.com/profile": { email: "user@example.com" }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: 3600
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const started = await startOpenAiSubscriptionOAuth({ profileId: "llm_subscription", model: "gpt-5-codex" });
    await expect(handleOpenAiSubscriptionNavigation({
      tabId: started.tabId,
      url: `http://localhost:1455/auth/callback?code=auth-code&state=${encodeURIComponent(started.state)}`
    })).resolves.toBe(true);

    const stored = getChromeStorageSnapshot();
    expect(stored["openAiSubscriptionCredential:llm_subscription"]).toMatchObject({
      accessToken,
      refreshToken: "refresh-token",
      accountId: "account-123",
      email: "user@example.com",
      planType: "plus"
    });
    expect(stored.llmConfig.llmModels.find(profile => profile.id === "llm_subscription")).toMatchObject({
      id: "llm_subscription",
      apiType: "openai-subscription",
      credentialId: "llm_subscription",
      accountId: "account-123",
      model: "gpt-5-codex"
    });
    expect(JSON.stringify(stored.llmConfig)).not.toContain("refresh-token");
  });
});
