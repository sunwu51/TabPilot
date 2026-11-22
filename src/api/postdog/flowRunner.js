/**
 * Flow (编排) runner. Runs the steps of a flow one after another and stops at the first failing step.
 *
 * A step fails only when something throws: a script error (incl. $.assert), a request that could
 * not be sent, or a network error. The HTTP status code never fails a step by itself.
 *
 * The runner is UI-agnostic: `send(action, payload)` talks to the background, `onUpdate(run)`
 * receives a fresh snapshot after every state change, and `signal` (AbortSignal) stops the run
 * between steps or during a delay.
 */

export function newFlowRunId() {
  return `pdfr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function describeFlowStep(step, requestsById) {
  if (step.type === "delay") return `sleep ${formatDelay(step.ms)}`;
  if (step.type === "script") return "script";
  const request = requestsById.get(step.requestId);
  return request ? `${request.method} ${request.name}` : "(missing request)";
}

export function formatDelay(ms) {
  const value = Math.max(0, Number(ms) || 0);
  return value >= 1000 && value % 100 === 0 ? `${value / 1000}s` : `${value}ms`;
}

export function createFlowRun(flow, requestsById, source = "page") {
  return {
    runId: newFlowRunId(),
    flowId: flow.id,
    flowName: flow.name,
    // "page": driven by an open Postdog page; "background": started by the assistant / MCP.
    source,
    startedAt: Date.now(),
    finishedAt: 0,
    status: "running",
    steps: flow.steps.map(step => ({
      stepId: step.id,
      type: step.type,
      label: describeFlowStep(step, requestsById),
      status: "pending"
    }))
  };
}

export async function runFlow({ flow, requests = [], send, onUpdate = () => {}, signal, source = "page" }) {
  const requestsById = new Map(requests.map(item => [item.id, item]));
  let run = createFlowRun(flow, requestsById, source);
  const emit = () => onUpdate(run);
  const patchStep = (index, patch) => {
    run = { ...run, steps: run.steps.map((step, i) => i === index ? { ...step, ...patch } : step) };
    emit();
  };
  emit();

  let failedAt = -1;
  for (let index = 0; index < flow.steps.length; index += 1) {
    if (signal?.aborted) break;
    const step = flow.steps[index];
    const startedAt = Date.now();
    patchStep(index, { status: "running", startedAt, ...(step.type === "delay" ? { delayUntil: startedAt + (Number(step.ms) || 0) } : {}) });

    let outcome;
    try {
      outcome = await runStep(step, { flow, requestsById, send, signal });
    } catch (error) {
      outcome = { passed: false, error: error?.message || String(error) };
    }
    if (outcome.aborted) {
      patchStep(index, { status: "stopped", durationMs: Date.now() - startedAt });
      break;
    }
    patchStep(index, {
      status: outcome.passed ? "passed" : "failed",
      durationMs: outcome.durationMs ?? Date.now() - startedAt,
      error: outcome.error || "",
      result: outcome.result
    });
    if (!outcome.passed) {
      failedAt = index;
      break;
    }
  }

  const stopped = failedAt < 0 && signal?.aborted;
  run = {
    ...run,
    status: failedAt >= 0 ? "failed" : stopped ? "stopped" : "passed",
    finishedAt: Date.now(),
    steps: run.steps.map(step => step.status === "pending" ? { ...step, status: "skipped" } : step)
  };
  emit();
  return run;
}

async function runStep(step, { flow, requestsById, send, signal }) {
  if (step.type === "delay") {
    const ok = await abortableSleep(Number(step.ms) || 0, signal);
    return ok ? { passed: true } : { aborted: true };
  }

  if (step.type === "script") {
    const res = await send("run_flow_script", { script: step.script || "" });
    if (!res?.success) return { passed: false, error: res?.error || "script step failed" };
    const data = res.data || {};
    const error = (data.logs || []).find(log => log.level === "error")?.message || "";
    return { passed: !!data.passed, durationMs: data.durationMs, error: data.passed ? "" : error, result: { kind: "script", ...data } };
  }

  if (!step.requestId || !requestsById.has(step.requestId)) {
    return { passed: false, error: "请求不存在（可能已被删除） / Request not found" };
  }
  const res = await send("run_request", {
    id: step.requestId,
    flow: { preScript: flow.preScript || "", postScript: flow.postScript || "" }
  });
  if (!res?.success) return { passed: false, error: res?.error || "run failed" };
  const data = res.data || {};
  const passed = data.passed ?? (!!data.success && !data.scriptFailed);
  const scriptError = (data.logs || []).find(log => log.level === "error");
  const error = passed ? "" : data.response?.error || (scriptError ? `${scriptError.phase}: ${scriptError.message}` : "failed");
  return { passed, durationMs: data.durationMs, error, result: { kind: "request", ...data } };
}

function abortableSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Concatenate the pre / post scripts of `folderId` and all of its ancestors, outermost (root)
 * folder first, each block headed by a comment naming its folder. Used by the "inherit folder
 * scripts" button, which pastes the result into the flow's script editors.
 */
export function collectFolderChainScripts(folders, folderId) {
  const byId = new Map(folders.map(item => [item.id, item]));
  const chain = [];
  const seen = new Set();
  let cursor = folderId;
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(byId.get(cursor));
    cursor = byId.get(cursor).parentId;
  }
  const path = [];
  const blocks = { pre: [], post: [] };
  for (const folder of chain) {
    path.push(folder.name);
    const title = path.join(" / ");
    if (folder.preScript?.trim()) blocks.pre.push(`// ---- 继承自文件夹「${title}」 ----\n${folder.preScript.trim()}`);
    if (folder.postScript?.trim()) blocks.post.push(`// ---- 继承自文件夹「${title}」 ----\n${folder.postScript.trim()}`);
  }
  return { pre: blocks.pre.join("\n\n"), post: blocks.post.join("\n\n"), folderCount: chain.length };
}
