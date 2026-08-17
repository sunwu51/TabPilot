import { describe, expect, it } from "vitest";
import { hasVisibleText } from "./textVisibility";

describe("hasVisibleText", () => {
  it("rejects whitespace and server timing probe characters", () => {
    expect(hasVisibleText(" \n\t")).toBe(false);
    expect(hasVisibleText("\u200B")).toBe(false);
    expect(hasVisibleText("\u200C\u200D\u2060\uFEFF")).toBe(false);
  });

  it("keeps visible text that follows a timing probe", () => {
    expect(hasVisibleText("\u200Bhello")).toBe(true);
    expect(hasVisibleText("\u200B你好")).toBe(true);
  });
});
