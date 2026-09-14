/* global chrome */
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SubscriptionUsage from "./SubscriptionUsage";
import { LocaleProvider } from "../i18n";

const profile = { id: "model-a", credentialId: "login-a", accountId: "account-a", apiType: "openai-subscription", email: "frank@example.com" };
const snapshot = {
  updatedAt: Date.now(), error: "", data: { planType: "plus", buckets: [{ id: "codex", name: "Codex", windows: [
    { id: "primary", durationSeconds: 18000, usedPercent: 32, resetsAt: Date.now() + 7200000 },
    { id: "secondary", durationSeconds: 604800, usedPercent: 96, resetsAt: Date.now() + 86400000 }
  ] }] }
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SubscriptionUsage", () => {
  it("does not query non-subscription profiles", () => {
    render(<SubscriptionUsage profile={{ ...profile, apiType: "openai-responses" }} />);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("opens an accessible detail card and manually refreshes", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ success: true, result: snapshot });
    render(<SubscriptionUsage compact profile={profile} />);
    await screen.findByText("已用 5h 32% · 7d 96%");
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(screen.getByRole("region", { name: "Codex 订阅用量" })).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getByText("账号：f***@example.com")).toBeInTheDocument();
    expect(screen.getAllByText(/重置.*·.*\d{1,2}:\d{2}/)).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "login-a", force: true })));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps stale data visible when refresh fails", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ success: true, result: { ...snapshot, error: "用量查询失败 (429)" } });
    render(<SubscriptionUsage profile={profile} />);
    expect(await screen.findByRole("status")).toHaveTextContent("保留上次数据");
    expect(screen.getByText("已用 32%")).toBeInTheDocument();
  });

  it("switches the usage details to English with the UI locale", async () => {
    const language = vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
    chrome.runtime.sendMessage.mockResolvedValue({ success: true, result: snapshot });
    render(<LocaleProvider><SubscriptionUsage compact profile={profile} /></LocaleProvider>);
    expect(await screen.findByText("Used 5h 32% · 7d 96%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(screen.getByRole("region", { name: "Codex subscription usage" })).toBeInTheDocument();
    expect(screen.getByText("Account: f***@example.com")).toBeInTheDocument();
    expect(screen.getAllByText(/Resets in about .* · at .*\d{1,2}:\d{2}/)).toHaveLength(2);
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument();
    language.mockRestore();
  });

  it("pauses automatic queries while hidden and cleans up timers", async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockResolvedValue({ success: true, result: snapshot });
    const view = render(<SubscriptionUsage profile={profile} />);
    await act(async () => {});
    chrome.runtime.sendMessage.mockClear();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { vi.advanceTimersByTime(5 * 60000); });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    visibility.mockRestore();
  });
});
