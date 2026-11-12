import { describe, expect, it } from "vitest";
import { createAgentJob, finishAgentJob, serializeAgentJob, nextDailyRun } from "./scheduleJobs";

describe("assistant schedules", () => {
  it("starts a one-second relative delay at creation, not before approval", () => {
    const job = createAgentJob({ prompt: "x", delaySeconds: 1 }, 500000);
    expect(job.fireTimestamp).toBe(501000);
  });
  it("finds midnight in an explicit time zone and advances after completion", () => {
    const now = Date.parse("2026-11-12T15:59:30Z");
    const job = createAgentJob({ prompt: "x", schedule: { type: "daily", time: "00:00", timeZone: "Asia/Shanghai" } }, now);
    expect(job.fireTimestamp).toBe(Date.parse("2026-11-12T16:00:00Z"));
    const finished = finishAgentJob(job, null, Date.parse("2026-11-12T16:05:00Z"));
    expect(finished.fireTimestamp).toBe(Date.parse("2026-11-13T16:00:00Z"));
    expect(finished.status).toBe("pending");
  });
  it("uses local time across daylight-saving changes", () => {
    expect(nextDailyRun("00:00", "America/New_York", Date.parse("2026-03-08T05:05:00Z"))).toBe(Date.parse("2026-03-09T04:00:00Z"));
    expect(nextDailyRun("02:30", "America/New_York", Date.parse("2026-03-08T06:00:00Z"))).toBe(Date.parse("2026-03-09T06:30:00Z"));
  });
  it("rejects invalid daily clock times and time zones", () => {
    expect(() => nextDailyRun("24:00", "UTC", Date.now())).toThrow();
    expect(() => nextDailyRun("00:00", "Not/AZone", Date.now())).toThrow();
  });
  it("keeps interval cadence and skips overlapping occurrences", () => {
    const job = createAgentJob({ prompt: "x", schedule: { type: "interval", everySeconds: 600 } }, 0);
    expect(job.fireTimestamp).toBe(600000);
    expect(finishAgentJob(job, null, 1900000).fireTimestamp).toBe(2400000);
  });
  it("creates only prompt-based tasks with safe defaults", () => {
    const job = createAgentJob({ prompt: "Inspect tabs", delaySeconds: 60 }, 1000);
    expect(job).toMatchObject({ kind: "agent", prompt: "Inspect tabs", status: "pending", fireTimestamp: 61000, allowDangerousTools: false, executeTimeoutMs: 600000 });
    expect(job).not.toHaveProperty("toolName");
    expect(job).not.toHaveProperty("toolArgs");
  });
  it("rejects invalid times, empty prompts and short repeat intervals", () => {
    for (const args of [{ prompt: "" }, { prompt: "x", timestamp: 1 }, { prompt: "x", delaySeconds: 1, repeatSeconds: 5 }, { prompt: "x", delaySeconds: 1, timeoutSeconds: -1 }]) {
      expect(() => createAgentJob(args, 1000)).toThrow();
    }
  });
  it("preserves the last outcome independently of the recurring task state", () => {
    const job = createAgentJob({ prompt: "x", delaySeconds: 1, repeatSeconds: 60 }, 1000);
    const finished = finishAgentJob({ ...job, sessionId: "s1", status: "running" }, "Could not load page", 9000);
    expect(finished).toMatchObject({ status: "pending", lastRunStatus: "failed", lastSessionId: "s1", lastError: "Could not load page", fireTimestamp: 62000, expiresAt: null });
    expect(serializeAgentJob(finished, 9000).remainingSeconds).toBe(53);
  });
  it("expires finished one-shot tasks after 24 hours", () => {
    const job = createAgentJob({ prompt: "x", delaySeconds: 1 }, 1000);
    expect(finishAgentJob(job, null, 9000)).toMatchObject({ status: "succeeded", lastRunStatus: "succeeded", expiresAt: 86409000 });
  });
});
