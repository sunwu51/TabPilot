import { describe, expect, it, vi } from "vitest";
import {
  cancelSessionApprovals,
  claimCurrentApproval,
  enqueueApproval,
  settleCurrentApproval
} from "./approvalQueue";

describe("approvalQueue", () => {
  it("presents concurrent approvals one at a time", async () => {
    const queues = new Map();
    const presented = [];
    const onActivate = entry => presented.push(entry.id);
    const first = enqueueApproval(queues, "session", { id: "first", cancelResult: false }, onActivate);
    const second = enqueueApproval(queues, "session", { id: "second", cancelResult: false }, onActivate);

    expect(presented).toEqual(["first"]);
    settleCurrentApproval(queues, "session", true, { onActivate });
    expect(await first).toBe(true);
    expect(presented).toEqual(["first", "second"]);
    settleCurrentApproval(queues, "session", true, { onActivate });
    expect(await second).toBe(true);
    expect(queues.has("session")).toBe(false);
  });

  it("continues to the next approval after a rejection", async () => {
    const queues = new Map();
    const first = enqueueApproval(queues, "session", { id: "first", cancelResult: false });
    const second = enqueueApproval(queues, "session", { id: "second", cancelResult: false });

    settleCurrentApproval(queues, "session", false);
    expect(await first).toBe(false);
    settleCurrentApproval(queues, "session", true);
    expect(await second).toBe(true);
  });

  it("cancels the active and queued approvals with their typed results", async () => {
    const queues = new Map();
    const dangerous = enqueueApproval(queues, "session", { cancelResult: false });
    const permission = enqueueApproval(queues, "session", { cancelResult: { granted: false } });

    expect(cancelSessionApprovals(queues, "session")).toBe(2);
    await expect(dangerous).resolves.toBe(false);
    await expect(permission).resolves.toEqual({ granted: false });
  });

  it("skips queued approvals from a stale run", async () => {
    const queues = new Map();
    const onActivate = vi.fn();
    const first = enqueueApproval(queues, "session", { id: "first", runId: 1, cancelResult: false }, onActivate);
    const stale = enqueueApproval(queues, "session", { id: "stale", runId: 1, cancelResult: false }, onActivate);

    settleCurrentApproval(queues, "session", true, {
      isValid: entry => entry.runId === 2,
      onActivate
    });

    await expect(first).resolves.toBe(true);
    await expect(stale).resolves.toBe(false);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(queues.has("session")).toBe(false);
  });

  it("allows only one click handler to claim an approval", () => {
    const queues = new Map();
    void enqueueApproval(queues, "session", { id: "first", cancelResult: false });

    expect(claimCurrentApproval(queues, "session")?.id).toBe("first");
    expect(claimCurrentApproval(queues, "session")).toBeNull();
  });
});
