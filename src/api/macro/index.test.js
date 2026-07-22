import { describe, expect, it } from "vitest";
import { MACRO_KIND, MACRO_SCHEMA_VERSION, normalizeMacro, normalizeStep, targetToSelectors } from "./index";

describe("browser macro schema", () => {
  it("normalizes recorded steps into the shared workflow format", () => {
    const node = normalizeStep({
      type: "input",
      selectors: ["[data-testid=search]", "//input[@name='q']"],
      value: "hello",
      timestamp: 123
    });

    expect(node).toEqual({
      do: expect.objectContaining({
        type: "type",
        text: "hello",
        target: {
          strategies: [
            { kind: "css", value: "[data-testid=search]" },
            { kind: "xpath", value: "//input[@name='q']" }
          ],
          fingerprint: expect.any(Object)
        }
      })
    });
  });

  it("stores only one versioned macro shape", () => {
    const macro = normalizeMacro({
      id: "macro_1",
      name: "Search",
      startUrl: "https://example.com",
      steps: [{ type: "click", selectors: ["#submit"] }]
    });

    expect(macro.kind).toBe(MACRO_KIND);
    expect(macro.schemaVersion).toBe(MACRO_SCHEMA_VERSION);
    expect(macro.steps).toBeUndefined();
    expect(targetToSelectors(macro.workflow.steps[0].do.target)).toEqual(["#submit"]);
  });
});
