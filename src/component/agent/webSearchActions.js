export function buildWebSearchActionLabels(action = {}) {
  if (action.type === "search") {
    const queries = normalizeWebSearchQueries(action);
    return queries.length > 0 ? queries.map(query => `search: ${query}`) : ["search"];
  }
  if (action.type === "open_page") return [`fetch: ${action.url || ""}`];
  return [action.type || "web_search"];
}

function normalizeWebSearchQueries(action) {
  const values = [
    ...(Array.isArray(action.query) ? action.query : [action.query]),
    ...(Array.isArray(action.queries) ? action.queries : [action.queries])
  ];
  const seen = new Set();
  return values
    .map(value => String(value || "").trim())
    .filter(value => value && !seen.has(value) && seen.add(value));
}
