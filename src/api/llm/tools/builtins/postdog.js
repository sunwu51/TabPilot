/* global chrome */

function sendPostdog(action, payload = {}) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "postdog_manager", action, payload }, response => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: "Empty Postdog response" });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || String(error) });
    }
  });
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
