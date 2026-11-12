/* global chrome */
import { describe, expect, it } from "vitest";
import { _execScheduleAgent, _execListScheduled } from "./schedule";
import { SCHEDULE_STORAGE_KEY } from "../../core/constants";

describe("scheduled assistant tools", () => {
  it("delegates creation to the background scheduler", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ success: true, scheduleId: "job1" });
    const args = { prompt: "Check open pages", delaySeconds: 60, repeatSeconds: 3600, allowDangerousTools: false };
    expect(await _execScheduleAgent(args)).toEqual({ success: true, scheduleId: "job1" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "schedule_manager", action: "schedule_agent", payload: args });
  });

  it("lists the agent policy and session as assistant tasks", async () => {
    await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: [{ id: "job1", kind: "agent", status: "pending", fireTimestamp: Date.now() + 60000, prompt: "Check pages", allowDangerousTools: false, repeatSeconds: 3600, sessionId: "s1" }] });
    const { scheduled } = await _execListScheduled();
    expect(scheduled[0]).toMatchObject({ kind: "agent", prompt: "Check pages", allowDangerousTools: false, sessionId: "s1", repeatSeconds: 3600 });
  });
});
