import { describe, expect, it } from "vitest";
import { buildWebSearchActionLabels } from "./webSearchActions";

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
});
