import { describe, expect, it, vi } from "vitest";
import { collectFolderChainScripts, runFlow } from "./flowRunner";

const requests = [
  { id: "r1", name: "login", method: "POST" },
  { id: "r2", name: "list", method: "GET" },
  { id: "r3", name: "detail", method: "GET" }
];

function okResult(extra = {}) {
  return { success: true, data: { success: true, passed: true, durationMs: 5, logs: [], tests: {}, response: { status: 200 }, ...extra } };
}

describe("flow runner", () => {
  it("runs steps in order, passes flow scripts to request steps and sleeps on delay steps", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => okResult());
      const flow = {
        id: "f1",
        name: "flow",
        preScript: "PRE",
        postScript: "POST",
        steps: [
          { id: "s1", type: "request", requestId: "r1" },
          { id: "s2", type: "delay", ms: 3000 },
          { id: "s3", type: "request", requestId: "r2" }
        ]
      };
      const pending = runFlow({ flow, requests, send });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2999);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const run = await pending;

      expect(send.mock.calls.map(call => call[1].id)).toEqual(["r1", "r2"]);
      expect(send.mock.calls[0]).toEqual(["run_request", { id: "r1", flow: { preScript: "PRE", postScript: "POST" } }]);
      expect(run.status).toBe("passed");
      expect(run.steps.map(step => step.status)).toEqual(["passed", "passed", "passed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at the first failing step and skips the rest", async () => {
    const send = vi.fn(async (_action, payload) => payload.id === "r2"
      ? okResult({ passed: false, logs: [{ level: "error", phase: "post", message: "boom" }] })
      : okResult());
    const flow = {
      id: "f1",
      name: "flow",
      steps: [
        { id: "s1", type: "request", requestId: "r1" },
        { id: "s2", type: "request", requestId: "r2" },
        { id: "s3", type: "request", requestId: "r3" }
      ]
    };
    const run = await runFlow({ flow, requests, send });

    expect(send).toHaveBeenCalledTimes(2);
    expect(run.status).toBe("failed");
    expect(run.steps.map(step => step.status)).toEqual(["passed", "failed", "skipped"]);
    expect(run.steps[1].error).toBe("post: boom");
  });

  it("fails a step whose request no longer exists, and runs script steps", async () => {
    const send = vi.fn(async () => ({ success: true, data: { passed: true, logs: [], tests: {}, durationMs: 1 } }));
    const run = await runFlow({
      flow: { id: "f", name: "f", steps: [{ id: "a", type: "script", script: "1" }, { id: "b", type: "request", requestId: "gone" }] },
      requests,
      send
    });
    expect(send).toHaveBeenCalledWith("run_flow_script", { script: "1" });
    expect(run.steps.map(step => step.status)).toEqual(["passed", "failed"]);
  });

  it("can be stopped during a delay", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => okResult());
    const pending = runFlow({
      flow: { id: "f", name: "f", steps: [{ id: "a", type: "delay", ms: 60000 }, { id: "b", type: "request", requestId: "r1" }] },
      requests,
      send,
      signal: controller.signal
    });
    controller.abort();
    const run = await pending;
    expect(send).not.toHaveBeenCalled();
    expect(run.status).toBe("stopped");
    expect(run.steps.map(step => step.status)).toEqual(["stopped", "skipped"]);
  });

  it("collects folder chain scripts from the outermost parent to the folder itself", () => {
    const folders = [
      { id: "c", name: "child", parentId: "b", preScript: "C_PRE", postScript: "" },
      { id: "a", name: "root", parentId: null, preScript: "A_PRE", postScript: "A_POST" },
      { id: "b", name: "mid", parentId: "a", preScript: "", postScript: "B_POST" }
    ];
    const result = collectFolderChainScripts(folders, "c");
    expect(result.folderCount).toBe(3);
    expect(result.pre.indexOf("A_PRE")).toBeLessThan(result.pre.indexOf("C_PRE"));
    expect(result.pre).toContain("root / mid / child");
    expect(result.post.indexOf("A_POST")).toBeLessThan(result.post.indexOf("B_POST"));
  });
});
