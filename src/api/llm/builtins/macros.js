/* global chrome */

function _sendMacroManagerMessage(action, payload = {}) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "macro_manager", action, payload }, response => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: "Empty macro manager response" });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || String(error) });
    }
  });
}

export async function _execListMacros({ query } = {}) {
  const res = await _sendMacroManagerMessage("list_for_ai", { query });
  if (!res?.success) return { error: res?.error || "Failed to list macros" };
  return { macros: res.data || [] };
}

export async function _execDescribeMacro({ id } = {}) {
  if (!id || typeof id !== "string") return { error: "id is required" };
  const res = await _sendMacroManagerMessage("describe_for_ai", { id });
  if (!res?.success) return { error: res?.error || "Failed to describe macro" };
  if (!res.data) return { error: `Macro not found: ${id}` };
  return { macro: res.data };
}

export async function _execRunMacro({ id, inputValues = {}, speed = "normal", stepDelayMs } = {}) {
  if (!id || typeof id !== "string") return { error: "id is required" };
  const options = { speed };
  if (stepDelayMs != null) options.stepDelayMs = Number(stepDelayMs);
  const res = await _sendMacroManagerMessage("replay", { id, inputValues, options });
  if (!res?.success) return { error: res?.error || "Failed to run macro" };
  return {
    tabId: res.tabId,
    report: res.report
  };
}
