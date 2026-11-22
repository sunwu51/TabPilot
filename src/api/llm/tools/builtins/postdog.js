import { requestBackground } from "../../../background/requests";

async function sendPostdog(action, payload = {}) {
  try {
    return await requestBackground({ type: "postdog_manager", action, payload })
      || { success: false, error: "Empty Postdog response" };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

function unwrap(res, key = "data", fallback = "Postdog operation failed") {
  if (!res?.success) return { error: res?.error || fallback };
  return { [key]: res.data };
}

export async function _execPostdogListFolders() {
  return unwrap(await sendPostdog("list_folders"), "folders");
}

export async function _execPostdogSaveFolder(args = {}) {
  const name = String(args.name || "").trim();
  if (!name) return { error: "name is required" };
  return unwrap(await sendPostdog("save_folder", {
    folder: {
      id: args.id,
      name,
      parentId: args.parentId || null,
      preScript: args.preScript || "",
      postScript: args.postScript || ""
    }
  }), "folder");
}

export async function _execPostdogListRequests(args = {}) {
  return unwrap(await sendPostdog("list_requests_for_ai", { query: args.query }), "requests");
}

export async function _execPostdogGetRequest(args = {}) {
  if (!args.id) return { error: "id is required" };
  return unwrap(await sendPostdog("get_request", { id: args.id }), "request");
}

export async function _execPostdogSaveRequest(args = {}) {
  const request = args.request && typeof args.request === "object" ? args.request : args;
  if (!request.name) return { error: "request.name is required" };
  return unwrap(await sendPostdog("save_request", { request }), "request");
}

export async function _execPostdogRunRequest(args = {}) {
  if (!args.id && !args.request) return { error: "id or request is required" };
  return unwrap(await sendPostdog("run_request", args), "result");
}

export async function _execPostdogListHistory(args = {}) {
  return unwrap(await sendPostdog("list_history", { requestId: args.requestId }), "history");
}

export async function _execPostdogGetHistoryRun(args = {}) {
  if (!args.runId) return { error: "runId is required" };
  return unwrap(await sendPostdog("get_history_run", { runId: args.runId }), "run");
}

export async function _execPostdogListEnvironments() {
  return unwrap(await sendPostdog("list_environments_for_ai"), "environments");
}

export async function _execPostdogSaveEnvironment(args = {}) {
  const environment = args.environment && typeof args.environment === "object" ? args.environment : args;
  if (!environment.name) return { error: "environment.name is required" };
  return unwrap(await sendPostdog("save_environment", { environment }), "environment");
}

export async function _execPostdogSetActiveEnvironment(args = {}) {
  if (!args.id) return { error: "id is required" };
  return unwrap(await sendPostdog("set_active_environment", { id: args.id }), "activeEnvironment");
}

export async function _execPostdogDeleteFolder(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) return { error: "id is required" };
  return unwrap(await sendPostdog("delete_folder", { id }), "folder");
}

export async function _execPostdogDeleteRequest(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) return { error: "id is required" };
  return unwrap(await sendPostdog("delete_request", { id }), "request");
}

export async function _execPostdogDeleteEnvironment(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) return { error: "id is required" };
  return unwrap(await sendPostdog("delete_environment", { id }), "environment");
}

export async function _execPostdogSetEnvironmentVariable(args = {}) {
  const environmentId = String(args.environmentId || "").trim();
  const key = String(args.key || "").trim();
  if (!environmentId || !key) return { error: "environmentId and key are required" };
  if (typeof args.value !== "string") return { error: "value must be a string" };
  return unwrap(await sendPostdog("set_environment_variable", {
    environmentId, key, value: args.value,
    options: { enabled: args.enabled, secret: args.secret }
  }), "environment");
}

export async function _execPostdogDeleteEnvironmentVariable(args = {}) {
  const environmentId = String(args.environmentId || "").trim();
  const key = String(args.key || "").trim();
  if (!environmentId || !key) return { error: "environmentId and key are required" };
  return unwrap(await sendPostdog("delete_environment_variable", { environmentId, key }), "environment");
}

// ------------------------------------------------------------------ flows (编排)

const FLOW_STEP_TYPES = new Set(["request", "delay", "script"]);

export async function _execPostdogListFlows(args = {}) {
  return unwrap(await sendPostdog("list_flows_for_ai", { query: args.query }), "flows");
}

export async function _execPostdogGetFlow(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) return { error: "id is required" };
  return unwrap(await sendPostdog("get_flow_for_ai", { id }), "flow");
}

/**
 * Create a flow, or update one by id. On update only the fields that are passed change
 * (e.g. passing just `name` keeps the existing steps and scripts).
 */
export async function _execPostdogSaveFlow(args = {}) {
  const input = args.flow && typeof args.flow === "object" ? args.flow : args;
  const id = String(input.id || "").trim();
  let base = {};
  if (id) {
    const existing = await sendPostdog("get_flow", { id });
    if (!existing?.success) return { error: existing?.error || `flow not found: ${id}` };
    base = existing.data;
  }
  const flow = { ...base };
  for (const key of ["name", "preScript", "postScript", "steps"]) {
    if (input[key] !== undefined) flow[key] = input[key];
  }
  if (!String(flow.name || "").trim()) return { error: "flow.name is required" };
  if (!Array.isArray(flow.steps)) flow.steps = [];

  const problems = [];
  flow.steps.forEach((step, index) => {
    if (!step || !FLOW_STEP_TYPES.has(step.type)) problems.push(`steps[${index}].type must be request, delay or script`);
    else if (step.type === "request" && !String(step.requestId || "").trim()) problems.push(`steps[${index}].requestId is required`);
    else if (step.type === "delay" && !(Number(step.ms) >= 0)) problems.push(`steps[${index}].ms must be a number >= 0`);
  });
  const requestIds = [...new Set(flow.steps.filter(step => step?.type === "request" && step.requestId).map(step => String(step.requestId)))];
  if (requestIds.length) {
    const listed = await sendPostdog("list_requests_for_ai", {});
    if (!listed?.success) return { error: listed?.error || "Failed to list requests" };
    const known = new Set((listed.data || []).map(item => item.id));
    const missing = requestIds.filter(requestId => !known.has(requestId));
    if (missing.length) problems.push(`unknown requestId: ${missing.join(", ")} (use postdog_list_requests)`);
  }
  if (problems.length) return { error: problems.join("; ") };

  const saved = await sendPostdog("save_flow", { flow });
  if (!saved?.success) return { error: saved?.error || "Failed to save flow" };
  return unwrap(await sendPostdog("get_flow_for_ai", { id: saved.data.id }), "flow");
}

export async function _execPostdogDeleteFlow(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) return { error: "id is required" };
  return unwrap(await sendPostdog("delete_flow", { id }), "flow");
}

export async function _execPostdogRunFlow(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) return { error: "id is required" };
  return unwrap(await sendPostdog("run_flow", { id }), "run");
}

export async function _execPostdogListFlowRuns(args = {}) {
  const flowId = String(args.flowId || "").trim();
  if (!flowId) return { error: "flowId is required" };
  return unwrap(await sendPostdog("list_flow_runs_for_ai", { flowId }), "runs");
}

export async function _execPostdogGetFlowRun(args = {}) {
  const runId = String(args.runId || "").trim();
  if (!runId) return { error: "runId is required" };
  return unwrap(await sendPostdog("get_flow_run_for_ai", { runId }), "run");
}
