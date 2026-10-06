export function buildWebSearchActionLabels(action = {}) {
  if (action.type === "search") {
    const queries = normalizeWebSearchQueries(action);
    if (queries.length > 0) {
      return queries.map(query => `search: ${query}`);
    }
    return ["search: 搜索中..."];
  }
  if (action.type === "open_page") return [`fetch: ${action.url || ""}`];
  return [action.type || "web_search"];
}

export function normalizeWebSearchQueries(action) {
  if (!action || typeof action !== "object") return [];
  const rawValues = [
    action.query,
    action.queries,
    action.search_query,
    action.search_queries,
    action.q,
    action.keyword,
    action.keywords,
    action.input?.query,
    action.input?.queries,
    action.input?.search_query,
    action.input?.q
  ];

  const flatValues = [];
  for (const val of rawValues) {
    if (Array.isArray(val)) {
      flatValues.push(...val);
    } else if (val != null) {
      flatValues.push(val);
    }
  }

  const seen = new Set();
  return flatValues
    .map(value => String(value || "").trim())
    .filter(value => value && !seen.has(value) && seen.add(value));
}
