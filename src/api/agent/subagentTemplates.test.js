import { describe, expect, it } from "vitest";
import { buildSubagentTemplateTools } from "./subagentTemplates";

describe("buildSubagentTemplateTools", () => {
  it("uses the configured description without appending parameter guidance", () => {
    const [tool] = buildSubagentTemplateTools([{
      id: "weather",
      templateName: "weather_assistant",
      description: "负责快速查询各地天气",
      enabled: true
    }]);

    expect(tool.description).toBe("负责快速查询各地天气 This tool will set up a new subagent to do the task.");
    expect(tool.name).toBe("subagent_weather_assistant");
  });
});
