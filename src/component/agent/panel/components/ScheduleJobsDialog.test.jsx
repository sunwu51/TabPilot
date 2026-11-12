/* global chrome */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../api/llm", () => ({ executeTool: vi.fn() }));
import { executeTool } from "../../../../api/llm";
import { ScheduleJobsDialogBody } from "./ScheduleJobsDialog";

afterEach(cleanup);
const job = { id: "j1", label: "Review MRs", prompt: "Review the open merge requests", status: "pending", fireTimestamp: Date.now() + 60000, fireAt: "Tomorrow", repeatSeconds: 3600, timeoutSeconds: 600, allowDangerousTools: false, lastRunStatus: "failed", lastError: "Network unavailable", lastFinishedAt: Date.now(), lastSessionId: "s1" };

describe("assistant task dialog", () => {
  it("shows task policy and last result separately from pending status", async () => {
    executeTool.mockResolvedValue({ scheduled: [job] });
    const open = vi.fn();
    render(<ScheduleJobsDialogBody onOpenSession={open} />);
    await screen.findByText("Review MRs");
    expect(screen.getByText(job.prompt)).toBeInTheDocument();
    expect(screen.getByText("等待执行")).toBeVisible();
    expect(screen.getByText("禁止")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable");
    fireEvent.click(screen.getByRole("button", { name: "查看会话" }));
    expect(open).toHaveBeenCalledWith("s1");
  });
  it("routes pause through the task manager and confirms deletion", async () => {
    executeTool.mockResolvedValue({ scheduled: [job] });
    chrome.runtime.sendMessage.mockResolvedValue({ success: true });
    render(<ScheduleJobsDialogBody />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "schedule_manager", action: "manage_agent", payload: { scheduleId: "j1", operation: "pause" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "删除" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ payload: { scheduleId: "j1", operation: "delete" } })));
  });
});
