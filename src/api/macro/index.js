/* global chrome */

export const MACROS_STORAGE_KEY = "macros";
export const MACRO_RECORDING_KEY = "macroRecording";
export const MACRO_KIND = "browser-macro";
export const MACRO_SCHEMA_VERSION = 1;

const ACTION_TYPES = new Set([
  "click", "double_click", "right_click", "type", "key_press", "key_down", "key_up",
  "select_all", "clear", "scroll", "wait", "wait_for", "navigate"
]);

export function newMacroId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `macro_${Date.now()}_${rand}`;
}

export function defaultMacroName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `macro_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function selectorsToTarget(selectors, fingerprint) {
  const strategies = (Array.isArray(selectors) ? selectors : [])
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .map(value => ({ kind: value.startsWith("/") ? "xpath" : "css", value }));
  return strategies.length ? { strategies, ...(fingerprint ? { fingerprint } : {}) } : undefined;
}

export function targetToSelectors(target) {
  return (target?.strategies || []).map(item => String(item?.value || "").trim()).filter(Boolean);
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object") return undefined;
  const strategies = (Array.isArray(target.strategies) ? target.strategies : []).map(item => ({
    kind: String(item?.kind || "").toLowerCase(),
    value: String(item?.value || "").trim()
  })).filter(item => ["css", "xpath"].includes(item.kind) && item.value);
  if (!strategies.length) return undefined;
  return {
    strategies,
    ...(Number.isInteger(target.nth) && target.nth >= 0 ? { nth: target.nth } : {}),
    ...(target.fingerprint && typeof target.fingerprint === "object" ? { fingerprint: target.fingerprint } : {})
  };
}

function legacyAction(step) {
  const target = selectorsToTarget(step.selectors, {
    tagName: String(step.tagName || "").toLowerCase() || undefined,
    name: typeof step.text === "string" ? step.text.slice(0, 200) : undefined
  });
  const common = { target, timestamp: Number(step.timestamp) || undefined };
  switch (String(step.type || "").toLowerCase()) {
    case "click": case "submit": return { type: "click", ...common };
    case "input": case "change": return { type: "type", ...common, text: String(step.value ?? ""), append: false, inputKind: step.inputKind, inputType: step.inputType, valueRef: step.valueRef, label: step.label, sensitive: step.sensitive === true, required: step.required === true };
    case "key": return { type: "key_press", ...common, key: String(step.key || "") };
    case "scroll": return { type: "scroll", ...common, scrollX: Math.max(0, Number(step.scrollX) || 0), scrollY: Math.max(0, Number(step.scrollY) || 0) };
    case "wait": return { type: "wait", durationMs: Math.max(0, Number(step.durationMs) || 0), timestamp: common.timestamp };
    case "wait_element": return { type: "wait_for", ...common, state: ["visible", "hidden", "present", "absent"].includes(step.state) ? step.state : "visible", timeoutMs: Math.max(100, Number(step.timeoutMs) || 6000) };
    case "wait_url": return { type: "wait_for", condition: "url", pattern: String(step.pattern || step.url || ""), timeoutMs: Math.max(100, Number(step.timeoutMs) || 10000), timestamp: common.timestamp };
    case "navigate": return { type: "navigate", url: String(step.url || step.pattern || ""), timeoutMs: Math.max(100, Number(step.timeoutMs) || 10000), timestamp: common.timestamp };
    default: return null;
  }
}

export function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = raw.target || raw.locator ? raw : legacyAction(raw);
  if (!source || !ACTION_TYPES.has(String(source.type || "").toLowerCase())) return null;
  const type = String(source.type).toLowerCase();
  const action = { ...source, type, target: normalizeTarget(source.target || source.locator) };
  delete action.locator; delete action.selectors; delete action.tagName; delete action.value;
  Object.keys(action).forEach(key => action[key] === undefined && delete action[key]);
  return action;
}

export function normalizeStep(step) {
  if (!step || typeof step !== "object") return null;
  if (step.do) { const action = normalizeAction(step.do); return action ? { do: action } : null; }
  if (step.waitFor) { const action = normalizeAction({ type: "wait_for", ...step.waitFor }); return action ? { waitFor: { ...action, type: undefined } } : null; }
  const action = normalizeAction(step);
  return action ? { do: action } : null;
}

export function macroSteps(macro) { return Array.isArray(macro?.workflow?.steps) ? macro.workflow.steps : []; }

export function normalizeMacro(macro) {
  if (!macro || typeof macro !== "object") return null;
  const id = String(macro.id || "").trim(); if (!id) return null;
  const startUrl = String(macro.startUrl || "").trim();
  const rawSteps = Array.isArray(macro.workflow?.steps) ? macro.workflow.steps : (Array.isArray(macro.steps) ? macro.steps : []);
  return {
    kind: MACRO_KIND, schemaVersion: MACRO_SCHEMA_VERSION, id,
    name: String(macro.name || "").trim() || id,
    startUrl, origin: String(macro.origin || "").trim() || safeOrigin(startUrl),
    createdAt: Number(macro.createdAt) || Date.now(), updatedAt: Number(macro.updatedAt) || Number(macro.createdAt) || Date.now(),
    requirements: { trustedInput: false, ...(macro.requirements || {}) },
    workflow: { version: 1, steps: rawSteps.map(normalizeStep).filter(Boolean) }
  };
}

export async function listMacros() { const res = await chrome.storage.local.get({ [MACROS_STORAGE_KEY]: [] }); return (Array.isArray(res[MACROS_STORAGE_KEY]) ? res[MACROS_STORAGE_KEY] : []).map(normalizeMacro).filter(Boolean); }
export async function getMacro(id) { return (await listMacros()).find(m => m.id === id) || null; }
export async function saveMacro(macro) { const normalized = normalizeMacro({ ...macro, updatedAt: Date.now() }); if (!normalized) throw new Error("invalid macro"); const list = await listMacros(); const index = list.findIndex(m => m.id === normalized.id); if (index >= 0) list[index] = normalized; else list.unshift(normalized); await chrome.storage.local.set({ [MACROS_STORAGE_KEY]: list }); return normalized; }
export async function deleteMacro(id) { const list = await listMacros(); const next = list.filter(m => m.id !== id); await chrome.storage.local.set({ [MACROS_STORAGE_KEY]: next }); return { id, removed: list.length - next.length }; }
export async function getRecording() { const res = await chrome.storage.local.get({ [MACRO_RECORDING_KEY]: null }); const value = res[MACRO_RECORDING_KEY]; return value && typeof value === "object" && value.draft && Number.isInteger(value.tabId) ? value : null; }
export async function setRecording(state) { if (state == null) { await chrome.storage.local.remove(MACRO_RECORDING_KEY); return null; } await chrome.storage.local.set({ [MACRO_RECORDING_KEY]: state }); return state; }
export async function clearRecording() { await chrome.storage.local.remove(MACRO_RECORDING_KEY); }

function safeOrigin(url) { try { return new URL(url).origin; } catch { return ""; } }
