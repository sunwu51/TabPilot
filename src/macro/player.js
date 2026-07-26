// Player: replays a sequence of recorded steps inside the page.
// Returns a structured report so the caller can show success/failure.

import { querySelectorWithFallback, querySelectorOne, isVisible } from "./selector";

const STEP_DELAY = {
  click: 200,
  input: 80,
  change: 80,
  submit: 200,
  key: 80,
  scroll: 100,
  wait: 0,
  wait_element: 0,
  wait_url: 0,
  navigate: 0
};

const WAIT_TIMEOUT_MS = 6000;
const WAIT_POLL_MS = 100;
const DEFAULT_ACTION_HIGHLIGHT_MS = 650;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForSelectors(selectors, timeoutMs = WAIT_TIMEOUT_MS) {
  if (!Array.isArray(selectors) || selectors.length === 0) return null;
  const deadline = Date.now() + timeoutMs;
  // Try once immediately.
  let found = querySelectorWithFallback(selectors);
  if (found) return found;

  return new Promise(resolve => {
    let observer = null;
    let interval = null;
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (observer) observer.disconnect();
      if (interval) clearInterval(interval);
      resolve(result);
    };

    const tick = () => {
      const f = querySelectorWithFallback(selectors);
      if (f) return finish(f);
      if (Date.now() >= deadline) return finish(null);
    };

    try {
      observer = new MutationObserver(tick);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false
      });
    } catch {
      observer = null;
    }
    interval = setInterval(tick, WAIT_POLL_MS);
  });
}

function urlMatches(pattern, currentUrl = location.href) {
  const p = String(pattern || "").trim();
  if (!p) return true;
  if (currentUrl === p || currentUrl.includes(p)) return true;
  try {
    return new RegExp(p).test(currentUrl);
  } catch {
    return false;
  }
}

async function waitForUrl(pattern, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (urlMatches(pattern)) return true;
    await sleep(WAIT_POLL_MS);
  }
  return false;
}

async function waitForElementState(selectors, state = "visible", timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const found = querySelectorWithFallback(selectors, { requireVisible: false });
    const visible = !!found && isVisible(found.element);
    if (state === "present" && found) return { ok: true, found };
    if (state === "visible" && visible) return { ok: true, found };
    if (state === "absent" && !found) return { ok: true, found: null };
    if (state === "hidden" && (!found || !visible)) return { ok: true, found };
    await sleep(WAIT_POLL_MS);
  }
  return { ok: false };
}

function setFormValue(el, value) {
  const tag = el.tagName.toLowerCase();
  const stringValue = String(value ?? "");
  let setter = null;
  if (tag === "input") {
    setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  } else if (tag === "textarea") {
    setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  } else if (tag === "select") {
    setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  }
  // Clear first so pages that restore draft/localStorage state do not append
  // the recorded text to an existing value.
  if (setter) setter.call(el, "");
  else el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  if (setter) setter.call(el, stringValue);
  else el.value = stringValue;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function isEditableTextElement(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable || el.getAttribute?.("role") === "textbox";
}

function setEditableText(el, value) {
  const tag = el.tagName.toLowerCase();
  const stringValue = String(value ?? "");
  if (tag === "input" || tag === "textarea") {
    setFormValue(el, stringValue);
    return;
  }

  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }

  // Prefer the editing command path for ProseMirror/contenteditable controls
  // because direct textContent changes often do not update editor state.
  let inserted = false;
  try {
    const selection = window.getSelection?.();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand?.("delete", false);
    inserted = document.execCommand?.("insertText", false, stringValue) === true;
  } catch {
    inserted = false;
  }

  if (!inserted) {
    el.textContent = stringValue;
  }

  try {
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: false,
      inputType: "insertText",
      data: stringValue
    }));
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function getEditableText(el) {
  const tag = el?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return String(el.value ?? "");
  }
  return String(el?.innerText ?? el?.textContent ?? "");
}

async function setEditableTextStable(el, value) {
  const expected = String(value ?? "");
  setEditableText(el, expected);
  // Some pages restore draft/localStorage content shortly after focus/hydration.
  // Re-apply once after a short delay if the value drifted.
  await sleep(300);
  if (getEditableText(el) !== expected) {
    setEditableText(el, expected);
  }
}

function highlightActionTarget(el, durationMs = DEFAULT_ACTION_HIGHLIGHT_MS) {
  if (!el || !el.getBoundingClientRect) return;
  const overlayId = "__tab_manager_macro_action_highlight__";
  document.getElementById(overlayId)?.remove();
  const rect = el.getBoundingClientRect();
  const div = document.createElement("div");
  div.id = overlayId;
  Object.assign(div.style, {
    position: "fixed",
    top: `${Math.max(0, rect.top - 6)}px`,
    left: `${Math.max(0, rect.left - 6)}px`,
    width: `${Math.max(8, rect.width + 12)}px`,
    height: `${Math.max(8, rect.height + 12)}px`,
    border: "3px solid #2563eb",
    background: "rgba(37, 99, 235, 0.16)",
    borderRadius: "8px",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxShadow: "0 0 0 9999px rgba(37,99,235,0.06)"
  });
  document.documentElement.appendChild(div);
  setTimeout(() => div.remove(), Math.max(150, Number(durationMs) || DEFAULT_ACTION_HIGHLIGHT_MS));
}

async function runStep(step, options = {}) {
  const selectors = (step.target?.strategies || []).map(item => item?.value).filter(Boolean);
  step = {
    ...step,
    selectors,
    ...(step.type === "type" ? { type: "input", value: step.text ?? "" } : {}),
    ...(step.type === "key_press" ? { type: "key" } : {}),
    ...(step.type === "wait_for" && step.condition === "url" ? { type: "wait_url" } : {}),
    ...(step.type === "wait_for" && step.condition !== "url" ? { type: "wait_element" } : {})
  };
  if (step.type === "wait") {
    await sleep(Math.max(0, Number(step.durationMs) || 0));
    return { ok: true };
  }

  if (step.type === "wait_url") {
    const pattern = step.pattern || step.url || "";
    const ok = await waitForUrl(pattern, Math.max(100, Number(step.timeoutMs) || 10000));
    return ok
      ? { ok: true }
      : { ok: false, error: `等待 URL 超时: ${pattern || "(空)"}`, currentUrl: location.href };
  }

  if (step.type === "navigate") {
    const url = String(step.url || step.pattern || "").trim();
    if (!url) return { ok: false, error: "navigate step 缺少 URL" };
    location.href = url;
    return { ok: true, navigationStarted: true };
  }

  if (step.type === "scroll") {
    window.scrollTo({
      left: Math.max(0, Number(step.scrollX) || 0),
      top: Math.max(0, Number(step.scrollY) || 0),
      behavior: "auto"
    });
    return { ok: true };
  }

  if (step.type === "wait_element") {
    const state = step.state || "visible";
    const result = await waitForElementState(
      step.selectors,
      state,
      Math.max(100, Number(step.timeoutMs) || WAIT_TIMEOUT_MS)
    );
    return result.ok
      ? { ok: true, usedSelector: result.found?.selector }
      : { ok: false, error: `等待元素 ${state} 超时`, selectors: step.selectors || [], currentUrl: location.href };
  }

  const found = await waitForSelectors(step.selectors);
  if (!found) {
    return {
      ok: false,
      error: "找不到匹配的元素（所有 selector 都失败）",
      selectors: step.selectors || [],
      currentUrl: location.href,
      stepText: step.text || "",
      tagName: step.tagName || ""
    };
  }
  const el = found.element;

  try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* ignore */ }
  if (options.highlight !== false) {
    highlightActionTarget(el, options.highlightMs);
    const pauseMs = Math.max(0, Number(options.highlightPauseMs) || 0);
    if (pauseMs) await sleep(pauseMs);
  }

  switch (step.type) {
    case "click": {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      el.click();
      return { ok: true, usedSelector: found.selector };
    }
    case "input": {
      if (!isEditableTextElement(el)) {
        return { ok: false, error: `元素不是可编辑输入区域: <${el.tagName.toLowerCase()}>` };
      }
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      await setEditableTextStable(el, step.value ?? "");
      return { ok: true, usedSelector: found.selector };
    }
    case "change": {
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        setFormValue(el, step.value ?? "");
        return { ok: true, usedSelector: found.selector };
      }
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        const target = step.value === "true" || step.value === true;
        if (el.checked !== target) {
          el.checked = target;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { ok: true, usedSelector: found.selector };
      }
      setFormValue(el, step.value ?? "");
      return { ok: true, usedSelector: found.selector };
    }
    case "submit": {
      if (typeof el.requestSubmit === "function") {
        el.requestSubmit();
      } else if (typeof el.submit === "function") {
        el.submit();
      } else {
        el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
      return { ok: true, usedSelector: found.selector };
    }
    case "key": {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      const init = { key: step.key, code: step.key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { ok: true, usedSelector: found.selector };
    }
    default:
      return { ok: false, error: `不支持的 step 类型: ${step.type}` };
  }
}

export async function play(steps, options = {}) {
  const startIndex = Math.max(0, Number(options.startIndex) || 0);
  const endIndex = options.singleStep ? Math.min(steps.length, startIndex + 1) : steps.length;
  const report = { total: steps.length, startIndex, success: 0, failed: 0, results: [] };
  for (let i = startIndex; i < endIndex; i++) {
    const step = steps[i];
    const result = await runStep(step, options);
    report.results.push({
      index: i,
      type: step.type,
      ok: !!result.ok,
      error: result.error,
      usedSelector: result.usedSelector,
      currentUrl: result.currentUrl,
      selectors: result.selectors,
      stepText: result.stepText,
      tagName: result.tagName
    });
    if (result.ok) {
      report.success++;
      const delay = Number.isFinite(Number(options.stepDelayMs))
        ? Math.max(0, Number(options.stepDelayMs))
        : (STEP_DELAY[step.type] ?? 150);
      await sleep(delay);
      if (result.navigationStarted) break;
    } else {
      report.failed++;
      report.failedAt = i;
      break;
    }
  }
  report.ok = report.failed === 0;
  return report;
}

export function probeSelectors(selectors) {
  const found = querySelectorWithFallback(selectors, { requireVisible: false });
  if (!found) return { found: false };
  return {
    found: true,
    selector: found.selector,
    visible: isVisible(found.element),
    tagName: found.element.tagName.toLowerCase(),
    text: (found.element.innerText || found.element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
  };
}

export function highlightSelectors(selectors, durationMs = 1200) {
  const found = querySelectorWithFallback(selectors, { requireVisible: false });
  if (!found) return false;
  const el = found.element;
  try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* ignore */ }
  const overlayId = "__tab_manager_macro_highlight__";
  document.getElementById(overlayId)?.remove();
  const rect = el.getBoundingClientRect();
  const div = document.createElement("div");
  div.id = overlayId;
  Object.assign(div.style, {
    position: "fixed",
    top: `${Math.max(0, rect.top - 6)}px`,
    left: `${Math.max(0, rect.left - 6)}px`,
    width: `${Math.max(8, rect.width + 12)}px`,
    height: `${Math.max(8, rect.height + 12)}px`,
    border: "3px solid #f59e0b",
    background: "rgba(245, 158, 11, 0.18)",
    borderRadius: "8px",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxShadow: "0 0 0 9999px rgba(0,0,0,0.06)"
  });
  document.documentElement.appendChild(div);
  setTimeout(() => div.remove(), durationMs);
  return true;
}

// Re-export so content.js stays the single import point if needed.
export { querySelectorOne };
