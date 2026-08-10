import { describe, expect, it } from "vitest";
import { buildSkillsSystemPrompt } from "./skills";

describe("skills system prompt", () => {
  it("routes skill detail loading through the code-mode MCP namespace", () => {
    const prompt = buildSkillsSystemPrompt({
      serverUrl: "http://localhost:5151/mcp",
      skills: [{ path: "web-server", name: "Web server", description: "Build web servers" }]
    });

    expect(prompt).toContain("tools.mcp.skill_bridge.get_skill_detail");
    expect(prompt).toContain('tools.describeTool("skill_bridge", "get_skill_detail")');
    expect(prompt).not.toContain("mcp_skill_bridge_get_skill_detail");
  });
});
