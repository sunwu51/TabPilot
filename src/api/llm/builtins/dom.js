import { _resolveControllableTab, _executePageAction } from "./_shared";

export async function _execDomQuery({ tabId, selector, text, matchExact, maxResults }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_query",
    { selector, text, matchExact, maxResults },
    "This page may need to be refreshed before DOM inspection can run."
  );
}

/**
 * Click a matching DOM element on a page.
 */
export async function _execDomClick({ tabId, selector, text, matchExact, index }) {
  const resolved = await _resolveControllableTab(tabId, "interact with");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_click",
    { selector, text, matchExact, index },
    "This page may need to be refreshed before DOM interactions can run."
  );
}

/**
 * Set the value of a form field on a page.
 */
export async function _execDomSetValue({ tabId, selector, text, matchExact, index, value }) {
  const resolved = await _resolveControllableTab(tabId, "edit");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_set_value",
    { selector, text, matchExact, index, value },
    "This page may need to be refreshed before form fields can be edited."
  );
}

/**
 * Temporarily style a DOM element on a page.
 */
export async function _execDomStyle({ tabId, selector, text, matchExact, index, styles, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "style");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_style",
    { selector, text, matchExact, index, styles, durationMs },
    "This page may need to be refreshed before styles can be modified."
  );
}

/**
 * Get HTML from a matched DOM element on a page.
 */
export async function _execDomGetHtml({ tabId, selector, text, matchExact, index, mode, maxLength }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_get_html",
    { selector, text, matchExact, index, mode, maxLength },
    "This page may need to be refreshed before DOM HTML can be read."
  );
}

/**
 * Scroll to and visually highlight a DOM element on the page.
 */
export async function _execDomHighlight({ tabId, selector, text, matchExact, index, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "highlight");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_highlight",
    { selector, text, matchExact, index, durationMs },
    "This page may need to be refreshed before highlighting can run."
  );
}
