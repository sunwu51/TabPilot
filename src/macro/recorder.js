/* global chrome */
// Recorder runs inside the content script.
// Activates only when chrome.storage.local.macroRecording.tabId matches this tab,
// detected indirectly: service worker tells us, OR we infer "i am the target" by
// asking the SW for current tab id when storage changes.

import { generateSelectors } from "./selector";
import {
  showRecordingBar,
  updateRecordingBar,
  hideRecordingBar,
  showNavigationPrompt,
  hideNavigationPrompt,
  isPromptVisible
} from "./overlay";

const KEY = "macroRecording";

const state = {
  active: false,
  draftName: "",
  stepCount: 0,
  pendingNavigation: null,
  pendingNavigationConfirmed: false,
  inputDebounceTimers: new WeakMap(),
  scrollTimer: null,
  lastClickStep: null,
  hasPasswordInput: false,
  lastTextInputAt: 0
};

const handlers = {};

function reportStep(step) {
  state.stepCount += 1;
  updateRecordingBar({ stepCount: state.stepCount });
  return sendStepMessage("macro_record_step", step);
}

function sendStepMessage(type, step) {
  try {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type, step }, response => {
        resolve({ success: !chrome.runtime.lastError && response?.success !== false });
      });
    });
  } catch {
    // ignore (service worker asleep is OK; storage observer will sync later)
    return Promise.resolve({ success: false });
  }
}

function reportStepReplacingLast(step) {
  return sendStepMessage("macro_replace_last_step", step);
}

async function reportStepsInOrder(steps) {
  for (const step of steps) {
    await reportStep(step);
  }
}

function sameSelectorTarget(a, b) {
  const aFirst = a?.selectors?.[0] || "";
  const bFirst = b?.selectors?.[0] || "";
  return !!aFirst && aFirst === bFirst;
}

function reportInputStep(target) {
  state.lastTextInputAt = Date.now();
  const step = buildBaseStep("input", target);
  step.value = getEditableValue(target);
  step.inputKind = getInputKind(target);
  if (isPasswordInput(target)) {
    state.hasPasswordInput = true;
    step.sensitive = true;
    step.inputType = "password";
    step.label = extractTargetText(target) || target.getAttribute("name") || target.getAttribute("id") || "password";
  }
  const previous = target.__tabManagerLastInputStep;
  const now = Date.now();
  if (previous && sameSelectorTarget(previous, step) && now - (previous.timestamp || 0) < 3000) {
    target.__tabManagerLastInputStep = step;
    reportStepReplacingLast(step);
    return;
  }
  target.__tabManagerLastInputStep = step;
  reportStep(step);
}

function buildBaseStep(type, target) {
  const selectors = generateSelectors(target);
  return {
    type,
    selectors,
    tagName: target?.tagName?.toLowerCase(),
    text: extractTargetText(target),
    timestamp: Date.now()
  };
}

function getEditableTarget(target) {
  if (!target || target.nodeType !== 1) return null;
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return target;
  if (target.isContentEditable) return target;
  return target.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]') || null;
}

function isTextEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") return target.type !== "checkbox" && target.type !== "radio";
  return target.isContentEditable || target.getAttribute?.("role") === "textbox";
}

function getEditableValue(target) {
  if (!target) return "";
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return String(target.value ?? "");
  return String(target.innerText ?? target.textContent ?? "");
}

function getInputKind(target) {
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return tag;
  return "contenteditable";
}

function isPasswordInput(target) {
  return target?.tagName?.toLowerCase() === "input" && target.type === "password";
}

function extractTargetText(target) {
  if (!target) return "";
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    return target.getAttribute("placeholder") || target.getAttribute("aria-label") || "";
  }
  const text = (target.innerText || target.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

function isOurOverlayTarget(event) {
  // Avoid recording clicks on our own UI.
  const path = event.composedPath ? event.composedPath() : [];
  for (const node of path) {
    if (node && node.id && typeof node.id === "string" && node.id.startsWith("__tab_manager_macro_")) {
      return true;
    }
  }
  return false;
}

function findActionableTarget(target) {
  if (!target) return null;
  // For clicks, walk up to find a meaningful target (button, link, etc.)
  let el = target;
  let depth = 0;
  while (el && el.nodeType === 1 && depth < 4) {
    const tag = el.tagName.toLowerCase();
    if (
      tag === "button" || tag === "a" || tag === "input" || tag === "select" ||
      tag === "textarea" || tag === "label" || tag === "summary" ||
      el.isContentEditable ||
      el.getAttribute("role") === "button" ||
      el.getAttribute("role") === "link" ||
      el.getAttribute("role") === "textbox" ||
      typeof el.onclick === "function"
    ) {
      return el;
    }
    el = el.parentElement;
    depth++;
  }
  return target;
}

// ============================ click ============================

handlers.click = function (event) {
  if (!state.active) return;
  if (isOurOverlayTarget(event)) return;
  if (event.button !== 0 && event.button !== undefined) return;

  const target = findActionableTarget(event.target);
  const tag = target?.tagName?.toLowerCase();

  // Anchor with cross-page href: intercept.
  if (tag === "a" && target.href) {
    if (shouldInterceptHref(target)) {
      event.preventDefault();
      event.stopPropagation();
      askNavigation(target.href, async () => {
        // Confirmed: record click and let navigation happen by clicking again.
        const step = buildBaseStep("click", target);
        await reportStepsInOrder([step, {
          type: "wait_url",
          selectors: [],
          url: target.href,
          pattern: target.href,
          timeoutMs: 15000,
          timestamp: Date.now()
        }]);
        finishRecordingAndNavigate(target.href);
      });
      return;
    }
  }

  // Form submit button etc. is captured by submit handler; still record click.
  const step = buildBaseStep("click", target);
  state.lastClickStep = step;
  reportStep(step);
};

function shouldInterceptHref(anchor) {
  // target=_blank etc. are allowed to open in new tab freely (per decision).
  const targetAttr = (anchor.getAttribute("target") || "").toLowerCase();
  if (targetAttr === "_blank" || targetAttr === "_new") return false;
  let nextUrl;
  try {
    nextUrl = new URL(anchor.href, location.href);
  } catch {
    return false;
  }
  if (nextUrl.protocol === "javascript:") return false;
  // Same-page hash navigation is fine.
  if (
    nextUrl.origin === location.origin &&
    nextUrl.pathname === location.pathname &&
    nextUrl.search === location.search
  ) {
    return false;
  }
  return true;
}

// ============================ submit ============================

handlers.submit = function (event) {
  if (!state.active) return;
  if (isOurOverlayTarget(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const form = event.target;
  const step = buildBaseStep("submit", form);
  // Determine where the form would have gone for the prompt.
  const action = form?.getAttribute("action") || location.href;
  let targetUrl;
  try {
    targetUrl = new URL(action, location.href).href;
  } catch {
    targetUrl = action || location.href;
  }
  askNavigation(targetUrl, async () => {
    if (state.lastClickStep && Date.now() - state.lastClickStep.timestamp < 1500) {
      await reportStepReplacingLast(step);
    } else {
      await reportStep(step);
    }
    await reportStep({
      type: "wait_url",
      selectors: [],
      url: targetUrl,
      pattern: targetUrl,
      timeoutMs: 15000,
      timestamp: Date.now()
    });
    finishRecordingAndNavigate(targetUrl, form);
  });
};

// ============================ input / change ============================

handlers.input = function (event) {
  if (!state.active) return;
  if (!event.target || isOurOverlayTarget(event)) return;
  const target = getEditableTarget(event.target);
  if (!isTextEditableTarget(target)) return;

  const existing = state.inputDebounceTimers.get(target);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.inputDebounceTimers.delete(target);
    reportInputStep(target);
  }, 300);
  state.inputDebounceTimers.set(target, timer);
};

handlers.change = function (event) {
  if (!state.active) return;
  const target = event.target;
  if (!target || isOurOverlayTarget(event)) return;
  const tag = target.tagName?.toLowerCase();
  if (tag === "select") {
    const step = buildBaseStep("change", target);
    step.value = String(target.value ?? "");
    reportStep(step);
    return;
  }
  if (tag === "input" && (target.type === "checkbox" || target.type === "radio")) {
    const step = buildBaseStep("change", target);
    step.value = String(target.checked);
    reportStep(step);
  }
};

// ============================ key ============================

const SEMANTIC_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

handlers.keydown = function (event) {
  if (!state.active) return;
  if (isOurOverlayTarget(event)) return;
  if (!SEMANTIC_KEYS.has(event.key)) return;
  const target = getEditableTarget(event.target) || event.target;
  // Flush any pending input first.
  if (target && state.inputDebounceTimers.has(target)) {
    const t = state.inputDebounceTimers.get(target);
    clearTimeout(t);
    state.inputDebounceTimers.delete(target);
    reportInputStep(target);
  }
  const step = buildBaseStep("key", target);
  step.key = event.key;
  reportStep(step);
};

// ============================ scroll ============================

handlers.scroll = function () {
  if (!state.active) return;
  // Textarea/contenteditable autosize or focus can produce scroll(0,0) while
  // typing. Treat scrolls immediately after text input as noise unless the
  // page actually moved away from the origin.
  const now = Date.now();
  const sx = window.scrollX || 0;
  const sy = window.scrollY || 0;
  if (now - state.lastTextInputAt < 800 && sx === 0 && sy === 0) return;
  if (state.scrollTimer) clearTimeout(state.scrollTimer);
  state.scrollTimer = setTimeout(() => {
    state.scrollTimer = null;
    const step = {
      type: "scroll",
      selectors: [],
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
      timestamp: Date.now()
    };
    reportStep(step);
  }, 350);
};

// ============================ beforeunload ============================

handlers.beforeunload = function (event) {
  if (!state.active) return;
  if (state.pendingNavigationConfirmed) return;
  event.preventDefault();
  event.returnValue = "正在录制宏，确定要离开此页面吗？";
  return event.returnValue;
};

// ============================ navigation prompt ============================

function askNavigation(url, onConfirmed) {
  if (isPromptVisible()) return;
  state.pendingNavigation = { url, onConfirmed };
  showNavigationPrompt({
    url,
    onConfirmStop: () => {
      hideNavigationPrompt();
      const cb = state.pendingNavigation?.onConfirmed;
      state.pendingNavigation = null;
      cb && cb();
    },
    onCancel: () => {
      hideNavigationPrompt();
      state.pendingNavigation = null;
    }
  });
}

function finishRecordingAndNavigate(url, form) {
  state.pendingNavigationConfirmed = true;
  if (form && typeof form.submit === "function") {
    try { form.submit(); return; } catch { /* fall through */ }
  }
  try { location.href = url; } catch { /* ignore */ }
}

// ============================ start / stop ============================

function start(meta) {
  if (state.active) return;
  state.active = true;
  state.draftName = meta?.name || "录制中";
  state.stepCount = Number(meta?.stepCount) || 0;
  state.pendingNavigationConfirmed = false;
  state.hasPasswordInput = !!meta?.hasPasswordInput;

  document.addEventListener("click", handlers.click, true);
  document.addEventListener("submit", handlers.submit, true);
  document.addEventListener("input", handlers.input, true);
  document.addEventListener("change", handlers.change, true);
  document.addEventListener("keydown", handlers.keydown, true);
  window.addEventListener("scroll", handlers.scroll, { capture: true, passive: true });
  window.addEventListener("beforeunload", handlers.beforeunload);

  showRecordingBar({
    name: state.draftName,
    stepCount: state.stepCount,
    onStop: () => {
      try {
        let replacePasswords = false;
        if (state.hasPasswordInput) {
          replacePasswords = !window.confirm(
            "发现录制过程中有密码输入。\n\n选择“确定”：记录真实密码（将会明文存到本地宏数据中）。\n选择“取消”：用 1A2b3!4399 代替密码。"
          );
        }
        chrome.runtime.sendMessage({ type: "macro_manager", action: "stop", payload: { commit: true, replacePasswords } });
      } catch { /* ignore */ }
    },
    onDiscard: () => {
      try {
        chrome.runtime.sendMessage({ type: "macro_manager", action: "stop", payload: { commit: false } });
      } catch { /* ignore */ }
    }
  });
}

function stop() {
  if (!state.active) {
    hideRecordingBar();
    hideNavigationPrompt();
    return;
  }
  state.active = false;
  document.removeEventListener("click", handlers.click, true);
  document.removeEventListener("submit", handlers.submit, true);
  document.removeEventListener("input", handlers.input, true);
  document.removeEventListener("change", handlers.change, true);
  document.removeEventListener("keydown", handlers.keydown, true);
  window.removeEventListener("scroll", handlers.scroll, { capture: true, passive: true });
  window.removeEventListener("beforeunload", handlers.beforeunload);
  if (state.scrollTimer) {
    clearTimeout(state.scrollTimer);
    state.scrollTimer = null;
  }
  hideRecordingBar();
  hideNavigationPrompt();
}

// ============================ activation ============================

let myTabId = null;

async function fetchMyTabId() {
  if (myTabId != null) return myTabId;
  try {
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "macro_get_my_tab_id" }, r => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r);
      });
    });
    if (res && Number.isInteger(res.tabId)) {
      myTabId = res.tabId;
    }
  } catch {
    // ignore
  }
  return myTabId;
}

export async function activateRecorderIfNeeded() {
  try {
    const res = await chrome.storage.local.get({ [KEY]: null });
    const recording = res[KEY];
    const tabId = await fetchMyTabId();
    if (recording && Number.isInteger(recording.tabId) && tabId === recording.tabId) {
      start({
        name: recording.draft?.name,
        stepCount: recording.draft?.steps?.length || 0,
        hasPasswordInput: recording.draft?.steps?.some(s => s.type === "input" && s.inputType === "password")
      });
      // Sync count with whatever is stored
      updateRecordingBar({
        name: recording.draft?.name,
        stepCount: recording.draft?.steps?.length || 0
      });
    } else if (state.active) {
      // No longer recording for me.
      stop();
    }
  } catch {
    // ignore
  }
}

export function setupRecorderStorageWatcher() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[KEY]) return;
    activateRecorderIfNeeded();
  });
}

export function isRecording() {
  return state.active;
}
