// Player: replays a sequence of recorded steps inside the page.
// Returns a structured report so the caller can show success/failure.

import { querySelectorWithFallback, querySelectorOne, isVisible } from "./selector";

const STEP_DELAY = {
  click: 200,
  input: 80,
  change: 80,
  submit: 200,
  key: 80,
  scroll: 100
};

const WAIT_TIMEOUT_MS = 6000;
const WAIT_POLL_MS = 100;

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
  if (setter) setter.call(el, stringValue);
  else el.value = stringValue;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function runStep(step) {
  if (step.type === "scroll") {
    window.scrollTo({
      left: Math.max(0, Number(step.scrollX) || 0),
      top: Math.max(0, Number(step.scrollY) || 0),
      behavior: "auto"
    });
    return { ok: true };
  }

  const found = await waitForSelectors(step.selectors);
  if (!found) {
    return { ok: false, error: "找不到匹配的元素（所有 selector 都失败）" };
  }
  const el = found.element;

  try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* ignore */ }

  switch (step.type) {
    case "click": {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      el.click();
      return { ok: true, usedSelector: found.selector };
    }
    case "input": {
      const tag = el.tagName.toLowerCase();
      if (!["input", "textarea"].includes(tag)) {
        return { ok: false, error: `元素不是输入框: <${tag}>` };
      }
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      setFormValue(el, step.value ?? "");
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

export async function play(steps) {
  const report = { total: steps.length, success: 0, failed: 0, results: [] };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const result = await runStep(step);
    report.results.push({
      index: i,
      type: step.type,
      ok: !!result.ok,
      error: result.error,
      usedSelector: result.usedSelector
    });
    if (result.ok) {
      report.success++;
      const delay = STEP_DELAY[step.type] ?? 150;
      await sleep(delay);
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
