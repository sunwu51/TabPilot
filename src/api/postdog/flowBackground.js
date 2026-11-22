import { runFlow } from "./flowRunner";
import { listPostdogFlows, listPostdogRequests, savePostdogFlowRun } from "./index";
import { runPostdogFlowScript, runPostdogRequest } from "./runtime";

// runId -> AbortController for flows running in the background (assistant / MCP).
const activeRuns = new Map();

/**
 * Run a saved flow without a Postdog page (used by the assistant / MCP tools). Each state change is
 * stored as a flow run, so an open Postdog page shows the progress live and can stop it.
 */
export async function runPostdogFlowInBackground({ id } = {}) {
  const flowId = String(id || "").trim();
  const flow = (await listPostdogFlows()).find(item => item.id === flowId);
  if (!flow) throw new Error(`flow not found: ${flowId}`);
  if (flow.steps.length === 0) throw new Error("flow has no steps");
  const requests = await listPostdogRequests();
  const controller = new AbortController();
  let runId = "";
  let saveChain = Promise.resolve();
  const send = async (action, payload) => {
    try {
      if (action === "run_request") return { success: true, data: await runPostdogRequest(payload) };
      if (action === "run_flow_script") return { success: true, data: await runPostdogFlowScript(payload) };
      return { success: false, error: `unsupported flow action: ${action}` };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  };
  try {
    const finalRun = await runFlow({
      flow,
      requests,
      send,
      signal: controller.signal,
      source: "background",
      onUpdate: run => {
        if (!runId) {
          runId = run.runId;
          activeRuns.set(runId, controller);
        }
        saveChain = saveChain.then(() => savePostdogFlowRun(run)).catch(() => {});
      }
    });
    await saveChain;
    return finalRun;
  } finally {
    if (runId) activeRuns.delete(runId);
  }
}

export function stopPostdogFlowRun(runId) {
  const controller = activeRuns.get(String(runId || ""));
  if (!controller) return { runId, stopped: false };
  controller.abort();
  return { runId, stopped: true };
}

// ------------------------------------------------------------------ AI serialization

const BODY_PREVIEW_CHARS = 2000;

export function serializePostdogFlowForAi(flow, requests = [], { full = false } = {}) {
  if (!flow) return null;
  const byId = new Map(requests.map(item => [item.id, item]));
  return {
    id: flow.id,
    name: flow.name,
    stepCount: flow.steps.length,
    steps: flow.steps.map((step, index) => {
      const base = { index, id: step.id, type: step.type };
      if (step.type === "request") {
        const request = byId.get(step.requestId);
        return { ...base, requestId: step.requestId, request: request ? `${request.method} ${request.name}` : null, missing: !request };
      }
      if (step.type === "delay") return { ...base, ms: step.ms };
      return full ? { ...base, script: step.script } : { ...base, scriptLines: String(step.script || "").split("\n").length };
    }),
    ...(full
      ? { preScript: flow.preScript, postScript: flow.postScript }
      : { hasPreScript: !!flow.preScript.trim(), hasPostScript: !!flow.postScript.trim() }),
    updatedAt: flow.updatedAt
  };
}

export function summarizePostdogFlowRunForAi(run, { details = false } = {}) {
  if (!run) return null;
  const steps = run.steps || [];
  const summary = {
    runId: run.runId,
    flowId: run.flowId,
    flowName: run.flowName,
    source: run.source || "page",
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    durationMs: run.finishedAt ? run.finishedAt - run.startedAt : null,
    passed: steps.filter(step => step.status === "passed").length,
    total: steps.length
  };
  const failed = steps.find(step => step.status === "failed");
  if (failed) summary.failedStep = { index: steps.indexOf(failed), label: failed.label, error: failed.error || "" };
  if (!details) return summary;
  summary.steps = steps.map((step, index) => {
    const out = { index, stepId: step.stepId, type: step.type, label: step.label, status: step.status };
    if (step.durationMs != null) out.durationMs = step.durationMs;
    if (step.error) out.error = step.error;
    const result = step.result;
    if (result?.kind === "request") {
      out.historyRunId = result.runId || null;
      out.httpStatus = result.response?.status ?? null;
      out.sent = result.request?.sent !== false;
      if (Object.keys(result.tests || {}).length) out.tests = result.tests;
      const errors = (result.logs || []).filter(log => log.level === "error");
      if (errors.length) out.errorLogs = errors;
      const body = String(result.response?.bodyText || "");
      if (body) out.bodyPreview = body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body;
    } else if (result?.kind === "script") {
      if (Object.keys(result.tests || {}).length) out.tests = result.tests;
      if ((result.logs || []).length) out.logs = result.logs.slice(0, 50);
    }
    return out;
  });
  return summary;
}
