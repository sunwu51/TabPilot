import { _resolveControllableTab, _executePageAction } from "./_shared";

export async function _execTabSnapshot({ tabId, maxResults, maxTextLength, maxSnapshotChars, includeHidden } = {}) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "tab_snapshot",
    { maxResults, maxTextLength, maxSnapshotChars, includeHidden },
    "This page may need to be refreshed before an interaction snapshot can be created."
  );
}

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
export async function _execDomClick({ tabId, snapshotId, ref, selector, text, matchExact, index }) {
  const resolved = await _resolveControllableTab(tabId, "interact with");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_click",
    { snapshotId, ref, selector, text, matchExact, index },
    "This page may need to be refreshed before DOM interactions can run."
  );
}

function _execDomAction(action, verb, failureHint, args) {
  return _resolveControllableTab(args.tabId, verb).then(resolved => {
    if (resolved.error) return { error: resolved.error };
    const params = { ...args };
    delete params.tabId;
    return _executePageAction(resolved.tab, action, params, failureHint);
  });
}

export async function _execDomDoubleClick(args) {
  return _execDomAction("dom_double_click", "double-click", "This page may need to be refreshed before double-clicking can run.", args);
}

export async function _execDomRightClick(args) {
  return _execDomAction("dom_right_click", "right-click", "This page may need to be refreshed before right-clicking can run.", args);
}

export async function _execDomCheck(args) {
  return _execDomAction("dom_check", "change", "This page may need to be refreshed before the checked state can be changed.", args);
}

export async function _execDomScrollIntoView(args) {
  return _execDomAction("dom_scroll_into_view", "scroll to", "This page may need to be refreshed before the element can be scrolled into view.", args);
}

export async function _execDomWait(args) {
  return _execDomAction("dom_wait", "wait for", "This page may need to be refreshed before waiting for DOM state.", args);
}

export async function _execDomHover({ tabId, snapshotId, ref, selector, text, matchExact, index }) {
  const resolved = await _resolveControllableTab(tabId, "hover over");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_hover",
    { snapshotId, ref, selector, text, matchExact, index },
    "This page may need to be refreshed before hover events can be dispatched."
  );
}

export async function _execDomFocus({ tabId, snapshotId, ref, selector, text, matchExact, index }) {
  const resolved = await _resolveControllableTab(tabId, "focus");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_focus",
    { snapshotId, ref, selector, text, matchExact, index },
    "This page may need to be refreshed before the element can be focused."
  );
}

/**
 * Set the value of a form field on a page.
 */
export async function _execDomSetValue({ tabId, snapshotId, ref, selector, text, matchExact, index, value }) {
  const resolved = await _resolveControllableTab(tabId, "edit");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_set_value",
    { snapshotId, ref, selector, text, matchExact, index, value },
    "This page may need to be refreshed before form fields can be edited."
  );
}

export async function _execDomSelectOption({ tabId, snapshotId, ref, selector, text, matchExact, index, values }) {
  const resolved = await _resolveControllableTab(tabId, "select options in");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_select_option",
    { snapshotId, ref, selector, text, matchExact, index, values },
    "This page may need to be refreshed before options can be selected."
  );
}

/**
 * Temporarily style a DOM element on a page.
 */
export async function _execDomStyle({ tabId, snapshotId, ref, selector, text, matchExact, index, styles, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "style");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_style",
    { snapshotId, ref, selector, text, matchExact, index, styles, durationMs },
    "This page may need to be refreshed before styles can be modified."
  );
}

/**
 * Get HTML from a matched DOM element on a page.
 */
export async function _execDomGetHtml({ tabId, snapshotId, ref, selector, text, matchExact, index, mode, maxLength }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_get_html",
    { snapshotId, ref, selector, text, matchExact, index, mode, maxLength },
    "This page may need to be refreshed before DOM HTML can be read."
  );
}

/**
 * Scroll to and visually highlight a DOM element on the page.
 */
export async function _execDomHighlight({ tabId, snapshotId, ref, selector, text, matchExact, index, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "highlight");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_highlight",
    { snapshotId, ref, selector, text, matchExact, index, durationMs },
    "This page may need to be refreshed before highlighting can run."
  );
}
