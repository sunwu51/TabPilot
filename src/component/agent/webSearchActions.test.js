import { describe, expect, it } from "vitest";
import { buildWebSearchActionLabels, normalizeWebSearchQueries } from "./webSearchActions";

describe("buildWebSearchActionLabels", () => {
  it("shows every query from query and queries arrays", () => {
    expect(buildWebSearchActionLabels({
      type: "search",
      query: ["first", "second"],
      queries: ["second", "third"]
    })).toEqual([
      "search: first",
      "search: second",
      "search: third"
    ]);
  });

  it("extracts queries from search_query, q, keyword, or nested input object", () => {
    expect(buildWebSearchActionLabels({
      type: "search",
      search_query: "claude web search"
    })).toEqual([
      "search: claude web search"
    ]);

    expect(buildWebSearchActionLabels({
      type: "search",
      input: { query: "weather today" }
    })).toEqual([
      "search: weather today"
    ]);
  });

  it("falls back to friendly search prompt when query is empty", () => {
    expect(buildWebSearchActionLabels({
      type: "search",
      query: ""
    })).toEqual([
      "search: 搜索中..."
    ]);
  });
});
