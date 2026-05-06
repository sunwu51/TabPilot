/* global chrome */

export const MACROS_STORAGE_KEY = "macros";
export const MACRO_RECORDING_KEY = "macroRecording";

const VALID_STEP_TYPES = new Set(["click", "input", "change", "submit", "key", "scroll"]);

export function newMacroId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `macro_${Date.now()}_${rand}`;
}

export function defaultMacroName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `macro_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function normalizeMacro(macro) {
  if (!macro || typeof macro !== "object") return null;
  const id = String(macro.id || "").trim();
  if (!id) return null;
  const name = String(macro.name || "").trim() || id;
  const startUrl = String(macro.startUrl || "").trim();
  const origin = String(macro.origin || "").trim() || safeOrigin(startUrl);
  const createdAt = Number(macro.createdAt) || Date.now();
  const updatedAt = Number(macro.updatedAt) || createdAt;
  const steps = Array.isArray(macro.steps) ? macro.steps.map(normalizeStep).filter(Boolean) : [];
  return { id, name, startUrl, origin, createdAt, updatedAt, steps };
}

export function normalizeStep(step) {
  if (!step || typeof step !== "object") return null;
  const type = String(step.type || "").toLowerCase();
  if (!VALID_STEP_TYPES.has(type)) return null;
  const selectors = Array.isArray(step.selectors)
    ? step.selectors.map(s => String(s || "").trim()).filter(Boolean)
    : [];
  const out = {
    type,
    selectors,
    tagName: String(step.tagName || "").toLowerCase() || undefined,
    text: typeof step.text === "string" ? step.text.slice(0, 200) : undefined,
    timestamp: Number(step.timestamp) || undefined
  };
  if (type === "input" || type === "change") {
    out.value = String(step.value ?? "");
  }
  if (type === "key") {
    out.key = String(step.key || "");
  }
  if (type === "scroll") {
    out.scrollX = Math.max(0, Number(step.scrollX) || 0);
    out.scrollY = Math.max(0, Number(step.scrollY) || 0);
  }
  return out;
}

export async function listMacros() {
  const res = await chrome.storage.local.get({ [MACROS_STORAGE_KEY]: [] });
  const arr = Array.isArray(res[MACROS_STORAGE_KEY]) ? res[MACROS_STORAGE_KEY] : [];
  return arr.map(normalizeMacro).filter(Boolean);
}

export async function getMacro(id) {
  const list = await listMacros();
  return list.find(m => m.id === id) || null;
}

export async function saveMacro(macro) {
  const normalized = normalizeMacro({ ...macro, updatedAt: Date.now() });
  if (!normalized) throw new Error("invalid macro");
  const list = await listMacros();
  const idx = list.findIndex(m => m.id === normalized.id);
  if (idx >= 0) {
    list[idx] = normalized;
  } else {
    list.unshift(normalized);
  }
  await chrome.storage.local.set({ [MACROS_STORAGE_KEY]: list });
  return normalized;
}

export async function deleteMacro(id) {
  const list = await listMacros();
  const next = list.filter(m => m.id !== id);
  await chrome.storage.local.set({ [MACROS_STORAGE_KEY]: next });
  return { id, removed: list.length - next.length };
}

export async function getRecording() {
  const res = await chrome.storage.local.get({ [MACRO_RECORDING_KEY]: null });
  const r = res[MACRO_RECORDING_KEY];
  if (!r || typeof r !== "object" || !r.draft || !Number.isInteger(r.tabId)) return null;
  return r;
}

export async function setRecording(state) {
  if (state == null) {
    await chrome.storage.local.remove(MACRO_RECORDING_KEY);
    return null;
  }
  await chrome.storage.local.set({ [MACRO_RECORDING_KEY]: state });
  return state;
}

export async function clearRecording() {
  await chrome.storage.local.remove(MACRO_RECORDING_KEY);
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
