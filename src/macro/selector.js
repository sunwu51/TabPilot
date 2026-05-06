// Selector generation + resolution shared between recorder and player.
// CSS selectors are plain strings; XPath expressions start with "/".

const RANDOM_ID_PATTERNS = [
  /:/,                       // CSS ":" pseudo-conflict (Tailwind / CSS modules)
  /--/,                      // CSS-modules style
  /^[0-9]+$/,                // pure numeric
  /[a-f0-9]{8,}/i,           // long hex chunk
  /^[a-z0-9_-]{24,}$/i       // long opaque tokens
];

const STABLE_DATA_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id"];

function looksRandom(value) {
  if (!value) return true;
  if (value.length > 32 && !/[\s_-]/.test(value)) return true;
  return RANDOM_ID_PATTERNS.some(re => re.test(value));
}

function isStableId(id) {
  if (!id) return false;
  if (id.length < 2 || id.length > 64) return false;
  return !looksRandom(id);
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/(["\\])/g, "\\$1");
}

export function isVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  return true;
}

export function xpathFirst(expr, root) {
  try {
    const result = document.evaluate(
      expr,
      root || document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue || null;
  } catch {
    return null;
  }
}

export function isXPath(selector) {
  return typeof selector === "string" && selector.startsWith("/");
}

export function querySelectorOne(selector) {
  if (!selector || typeof selector !== "string") return null;
  if (isXPath(selector)) return xpathFirst(selector);
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

export function querySelectorWithFallback(selectors, options = {}) {
  if (!Array.isArray(selectors)) return null;
  const requireVisible = options.requireVisible !== false;
  for (const s of selectors) {
    const el = querySelectorOne(s);
    if (el && (!requireVisible || isVisible(el))) {
      return { element: el, selector: s };
    }
  }
  return null;
}

function nthOfType(element) {
  const parent = element.parentElement;
  if (!parent) return 1;
  let i = 0;
  for (const child of parent.children) {
    if (child.tagName === element.tagName) {
      i++;
      if (child === element) return i;
    }
  }
  return 1;
}

function shortCssPath(element) {
  const parts = [];
  let current = element;
  let safety = 0;
  while (current && current.nodeType === 1 && current !== document.body && safety < 6) {
    const tag = current.tagName.toLowerCase();
    if (current.id && isStableId(current.id)) {
      parts.unshift(`#${cssEscape(current.id)}`);
      break;
    }
    let part = tag;
    const stableData = STABLE_DATA_ATTRS.find(a => current.getAttribute(a));
    if (stableData) {
      const v = current.getAttribute(stableData);
      part = `${tag}[${stableData}="${cssEscape(v)}"]`;
    } else {
      const idx = nthOfType(current);
      const sameTagSiblings = Array.from(current.parentElement?.children || []).filter(c => c.tagName === current.tagName);
      if (sameTagSiblings.length > 1) {
        part = `${tag}:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    current = current.parentElement;
    safety++;
  }
  return parts.join(" > ");
}

function uniqueCss(selector) {
  if (!selector) return false;
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1;
  } catch {
    return false;
  }
}

function uniqueXPath(expr) {
  if (!expr) return false;
  try {
    const result = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return result.snapshotLength === 1;
  } catch {
    return false;
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function generateSelectors(element) {
  if (!element || element.nodeType !== 1) return [];
  const tag = element.tagName.toLowerCase();
  const candidates = [];

  // 1. Stable data-* attributes
  for (const attr of STABLE_DATA_ATTRS) {
    const v = element.getAttribute(attr);
    if (v && !looksRandom(v)) {
      const sel = `[${attr}="${cssEscape(v)}"]`;
      if (uniqueCss(sel)) candidates.push(sel);
    }
  }

  // 2. Stable id
  if (element.id && isStableId(element.id)) {
    const sel = `#${cssEscape(element.id)}`;
    if (uniqueCss(sel)) candidates.push(sel);
  }

  // 3. name attribute (form fields)
  const nameAttr = element.getAttribute("name");
  if (nameAttr && !looksRandom(nameAttr)) {
    const formEl = element.closest("form");
    let sel = `${tag}[name="${cssEscape(nameAttr)}"]`;
    if (formEl && formEl.id && isStableId(formEl.id)) {
      sel = `#${cssEscape(formEl.id)} ${sel}`;
    }
    if (uniqueCss(sel)) candidates.push(sel);
  }

  // 4. aria-label
  const aria = element.getAttribute("aria-label");
  if (aria && aria.length <= 60) {
    const sel = `${tag}[aria-label="${cssEscape(aria)}"]`;
    if (uniqueCss(sel)) candidates.push(sel);
  }

  // 5. text-based XPath (limit to short text, avoid noisy matches)
  const text = normalizeText(element.innerText || element.textContent);
  if (text && text.length <= 40 && /\S/.test(text)) {
    const escaped = text.includes('"') ? `concat("${text.replace(/"/g, '","\'","')}")` : `"${text}"`;
    const xp = `//${tag}[normalize-space()=${escaped}]`;
    if (uniqueXPath(xp)) candidates.push(xp);
  }

  // 6. structural CSS path
  const structural = shortCssPath(element);
  if (structural && uniqueCss(structural) && !candidates.includes(structural)) {
    candidates.push(structural);
  }

  // 7. Fallback non-unique structural path (still useful as last resort)
  if (candidates.length === 0 && structural) {
    candidates.push(structural);
  }

  // De-duplicate while preserving order, cap at 5.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
    if (unique.length >= 5) break;
  }
  return unique;
}
