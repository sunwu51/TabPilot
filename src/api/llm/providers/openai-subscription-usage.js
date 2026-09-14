/* global chrome */
import { ensureOpenAiSubscriptionAccess } from "./openai-subscription-auth";

export const SUBSCRIPTION_USAGE_TTL = 5 * 60 * 1000;
const tasks = new Map();
const snapshots = new Map();

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWindow(window, id, now) {
  if (!window || typeof window !== "object") return null;
  const seconds = finiteNumber(window.limit_window_seconds);
  const resetAt = finiteNumber(window.reset_at);
  const resetAfter = finiteNumber(window.reset_after_seconds);
  const used = finiteNumber(window.used_percent);
  return {
    id,
    usedPercent: used === null ? null : Math.max(0, used),
    durationSeconds: seconds !== null && seconds > 0 ? seconds : null,
    resetsAt: resetAt !== null ? resetAt * 1000 : resetAfter !== null ? now + resetAfter * 1000 : null
  };
}

export function normalizeSubscriptionUsage(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object" || !("rate_limit" in payload)) {
    throw new Error("订阅用量返回格式无法识别");
  }
  const limits = [{ id: "codex", name: "Codex", details: payload.rate_limit }];
  for (const item of Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []) {
    if (item?.metered_feature && item.metered_feature !== "codex") {
      limits.push({ id: item.metered_feature, name: item.limit_name || item.metered_feature, details: item.rate_limit });
    }
  }
  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : "",
    buckets: limits.map(({ id, name, details }) => ({
      id,
      name,
      windows: [normalizeWindow(details?.primary_window, "primary", now), normalizeWindow(details?.secondary_window, "secondary", now)].filter(Boolean)
    }))
  };
}

export async function readSubscriptionUsage(credentialId, options = {}) {
  let credential = await ensureOpenAiSubscriptionAccess(credentialId);
  const key = JSON.stringify([credential.accountId, credential.email || ""]);
  const storageKey = `openAiSubscriptionUsage:${key}`;
  const stored = await chrome.storage.session?.get(storageKey);
  const previous = snapshots.get(key) || stored?.[storageKey] || { data: null, updatedAt: null, error: "" };
  if (options.cacheOnly) return previous;
  if (tasks.has(key)) return tasks.get(key);
  const age = Date.now() - (previous.updatedAt || 0);
  const maxAge = options.force ? 10000 : Math.max(60000, options.maxAge ?? SUBSCRIPTION_USAGE_TTL);
  if (previous.updatedAt && age < maxAge && !previous.error) return previous;
  if (previous.retryAt > Date.now() && !options.force) return previous;
  if (previous.attemptedAt && Date.now() - previous.attemptedAt < 10000) return previous;
  const task = (async () => {
    const attemptedAt = Date.now();
    try {
      const request = () => fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-Id": credential.accountId
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15000)
      });
      let response = await request();
      if (response.status === 401) {
        credential = await ensureOpenAiSubscriptionAccess(credentialId, { force: true });
        response = await request();
      }
      if (!response.ok) {
        throw new Error(response.status === 401 ? "授权失效，请重新登录" : `用量查询失败 (${response.status})`);
      }
      const data = normalizeSubscriptionUsage(await response.json());
      const snapshot = { data, updatedAt: Date.now(), error: "", attemptedAt };
      snapshots.set(key, snapshot);
      await chrome.storage.session?.set({ [storageKey]: snapshot });
      return snapshot;
    } catch (error) {
      const failures = (previous.failures || 0) + 1;
      const snapshot = {
        ...previous,
        error: error?.message || "用量查询失败",
        attemptedAt,
        failures,
        retryAt: Date.now() + (/重新登录/.test(error?.message) ? 24 * 60 * 60000 : Math.min(30 * 60000, 60000 * 2 ** (failures - 1)))
      };
      snapshots.set(key, snapshot);
      await chrome.storage.session?.set({ [storageKey]: snapshot });
      return snapshot;
    }
  })().finally(() => tasks.delete(key));
  tasks.set(key, task);
  return task;
}
