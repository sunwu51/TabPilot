/* global chrome */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureOpenAiSubscriptionAccess } from "./openai-subscription-auth";
import { normalizeSubscriptionUsage, readSubscriptionUsage } from "./openai-subscription-usage";

vi.mock("./openai-subscription-auth", () => ({ ensureOpenAiSubscriptionAccess: vi.fn() }));
const payload = { plan_type: "plus", rate_limit: {
  primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 1800000000 },
  secondary_window: { used_percent: 68, limit_window_seconds: 604800, reset_after_seconds: 3600 }
} };

describe("subscription usage", () => {
  beforeEach(() => {
    ensureOpenAiSubscriptionAccess.mockResolvedValue({ accountId: crypto.randomUUID(), accessToken: "test-token" });
    chrome.storage.session = chrome.storage.local;
  });

  it("normalizes actual window durations and reset timestamps", () => {
    const result = normalizeSubscriptionUsage(payload, 1000);
    expect(result.buckets[0].windows).toEqual([
      { id: "primary", usedPercent: 32, durationSeconds: 18000, resetsAt: 1800000000000 },
      { id: "secondary", usedPercent: 68, durationSeconds: 604800, resetsAt: 3601000 }
    ]);
  });

  it("does not interpret missing values as zero and preserves separate buckets", () => {
    const result = normalizeSubscriptionUsage({ rate_limit: { primary_window: { used_percent: null } }, additional_rate_limits: [
      { metered_feature: "other", limit_name: "Other", rate_limit: null }
    ] });
    expect(result.buckets[0].windows[0].usedPercent).toBeNull();
    expect(result.buckets[1]).toEqual({ id: "other", name: "Other", windows: [] });
    expect(() => normalizeSubscriptionUsage({ message: "error" })).toThrow("无法识别");
  });

  it("shares concurrent requests and cached results between models using one account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([readSubscriptionUsage("model-a"), readSubscriptionUsage("model-b")]);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
    await readSubscriptionUsage("model-b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("test-token");
  });

  it("retries unauthorized requests with refreshed credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await readSubscriptionUsage("retry");
    expect(result.error).toBe("");
    expect(ensureOpenAiSubscriptionAccess).toHaveBeenCalledWith("retry", { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains stale data on errors and backs off", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload))).mockResolvedValue(new Response("", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      const first = await readSubscriptionUsage("stale");
      vi.advanceTimersByTime(6 * 60000);
      const failed = await readSubscriptionUsage("stale");
      expect(failed.data).toEqual(first.data);
      expect(failed.updatedAt).toBe(first.updatedAt);
      expect(failed.error).toContain("429");
      await readSubscriptionUsage("stale");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cache-only reads never request usage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await readSubscriptionUsage("empty", { cacheOnly: true })).data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
