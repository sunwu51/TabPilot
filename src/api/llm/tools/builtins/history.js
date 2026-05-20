/* global chrome */

export async function _execHistorySearch({ query, maxResults }) {
  const results = await chrome.history.search({
    text: query,
    maxResults: maxResults || 10,
    startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 // last 30 days
  });
  return results.map(r => ({
    url: r.url,
    title: r.title,
    lastVisit: new Date(r.lastVisitTime).toISOString(),
    visitCount: r.visitCount
  }));
}

/**
 * List recent browser history within a time range.
 */
export async function _execHistoryRecent({ startTime, endTime, maxResults }) {
  const now = Date.now();
  const resolvedEndTime = Number.isFinite(endTime) ? endTime : now;
  const resolvedStartTime = Number.isFinite(startTime)
    ? startTime
    : (resolvedEndTime - 7 * 24 * 60 * 60 * 1000);
  const resolvedMaxResults = Math.min(100, Math.max(1, Number.isFinite(maxResults) ? Math.floor(maxResults) : 100));

  if (resolvedStartTime > resolvedEndTime) {
    return { error: "startTime must be less than or equal to endTime" };
  }

  const results = await chrome.history.search({
    text: "",
    maxResults: resolvedMaxResults,
    startTime: resolvedStartTime,
    endTime: resolvedEndTime
  });

  return {
    startTime: new Date(resolvedStartTime).toISOString(),
    endTime: new Date(resolvedEndTime).toISOString(),
    maxResults: resolvedMaxResults,
    results: results.map(r => ({
      url: r.url,
      title: r.title,
      lastVisit: new Date(r.lastVisitTime).toISOString(),
      visitCount: r.visitCount
    }))
  };
}
