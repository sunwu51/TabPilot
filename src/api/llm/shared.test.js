import { describe, expect, it, vi } from "vitest";
import {
  buildFirstPacketTimeoutError,
  createFirstPacketTimeoutState,
  createLlmStreamError,
  delayRetry,
  getFirstPacketTimeoutMs,
  isAbortError,
  mergeUsage,
  normalizeLlmStreamError,
} from "./shared";

describe("llm shared helpers", () => {
  it("merges usage while ignoring empty updates", () => {
    expect(mergeUsage({ input: 1 }, { output: 2 })).toEqual({ input: 1, output: 2 });
    expect(mergeUsage({ input: 1 }, null)).toEqual({ input: 1 });
  });

  it("normalizes first packet timeout config", () => {
    expect(getFirstPacketTimeoutMs({ firstPacketTimeoutSeconds: 3 })).toBe(3000);
    expect(getFirstPacketTimeoutMs({ firstPacketTimeoutSeconds: 0 })).toBe(20000);
    expect(getFirstPacketTimeoutMs({ firstPacketTimeoutSeconds: -5 })).toBe(1000);
  });

  it("aborts when first packet timeout expires", () => {
    vi.useFakeTimers();
    const state = createFirstPacketTimeoutState(null, 1000);

    expect(state.firstPacketReceived).toBe(false);
    expect(state.didTimeout).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(state.didTimeout).toBe(true);
    expect(state.signal.aborted).toBe(true);
    state.cleanup();
  });

  it("clears timeout after first packet is marked", () => {
    vi.useFakeTimers();
    const state = createFirstPacketTimeoutState(null, 1000);

    state.markFirstPacketReceived();
    vi.advanceTimersByTime(1000);

    expect(state.firstPacketReceived).toBe(true);
    expect(state.didTimeout).toBe(false);
    expect(state.signal.aborted).toBe(false);
    state.cleanup();
  });

  it("propagates parent abort reason", () => {
    const controller = new AbortController();
    const state = createFirstPacketTimeoutState(controller.signal, 1000);
    const reason = new Error("stop");

    controller.abort(reason);

    expect(state.signal.aborted).toBe(true);
    expect(state.signal.reason).toBe(reason);
    state.cleanup();
  });

  it("builds typed stream errors", () => {
    const error = buildFirstPacketTimeoutError({ firstPacketTimeoutSeconds: 7 });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("FIRST_PACKET_TIMEOUT");
    expect(error.detail).toEqual({ timeoutSeconds: 7 });
    expect(error.message).toContain("7 秒");
  });

  it("normalizes unknown, network, and typed errors", () => {
    const typed = createLlmStreamError({ code: "UPSTREAM", message: "bad", status: 500 });
    expect(normalizeLlmStreamError(typed, { apiType: "api", attempt: 1, maxAttempts: 3 })).toMatchObject({
      code: "UPSTREAM",
      apiType: "api",
      attempt: 1,
      maxAttempts: 3,
      status: 500
    });

    expect(normalizeLlmStreamError(new TypeError("fetch failed"), { apiType: "api", attempt: 2, maxAttempts: 3 }))
      .toMatchObject({ code: "NETWORK_ERROR", message: "fetch failed" });

    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  });

  it("delayRetry resolves and aborts correctly", async () => {
    vi.useFakeTimers();
    const promise = delayRetry(2);
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();

    const controller = new AbortController();
    const aborted = delayRetry(2, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });
});
