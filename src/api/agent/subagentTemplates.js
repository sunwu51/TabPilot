export const SUBAGENT_TEMPLATES_STORAGE_KEY = "subagentTemplates";

export function normalizeSubagentTemplates(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeSubagentTemplate(item, index)).filter(Boolean);
}

export function normalizeSubagentTemplate(value, index = 0) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || value.templateName || `template_${index + 1}`)
    .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `template_${index + 1}`;
  const templateName = String(value.templateName || value.name || id).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(templateName)) return null;
  return {
    id,
    templateName,
    description: String(value.description || "").trim(),
    systemPrompt: String(value.systemPrompt || "").trim(),
    modelProfileId: String(value.modelProfileId || "").trim(),
    allowedBuiltinDomains: Array.isArray(value.allowedBuiltinDomains)
      ? value.allowedBuiltinDomains.map(String).map(item => item.trim()).filter(Boolean)
      : [],
    allowedMcpServers: Array.isArray(value.allowedMcpServers)
      ? value.allowedMcpServers.map(String).map(item => item.trim()).filter(Boolean)
      : [],
    enabled: value.enabled !== false
  };
}

export function buildSubagentTemplateToolName(templateId) {
  return `subagent_${String(templateId || "").trim()}`;
}

export function findSubagentTemplateByToolName(templates, toolName) {
  const prefix = "subagent_";
  const name = String(toolName || "");
  if (!name.startsWith(prefix)) return null;
  return normalizeSubagentTemplates(templates).find(item => buildSubagentTemplateToolName(item.templateName) === name) || null;
}

export function buildSubagentTemplateTools(templates = []) {
  return normalizeSubagentTemplates(templates).filter(item => item.enabled).map(item => ({
    name: buildSubagentTemplateToolName(item.templateName),
    description: `${item.description || `Run the ${item.templateName} sub-agent.`} This tool will set up a new subagent to do the task.`,
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for this run, shown in the tool title." },
        task: { type: "string", description: "Self-contained task for the configured sub-agent." },
        maxIterations: { type: "number", description: "Optional maximum rounds for this subagent run." }
      },
      required: ["name", "task"]
    }
  }));
}

export function filterSubagentMcpTools(mcpTools = [], allowedServers = []) {
  const allowed = new Set((allowedServers || []).map(item => String(item).trim()).filter(Boolean));
  if (allowed.size === 0) return [];
  return mcpTools.filter(tool => allowed.has(String(tool?._serverName || "").trim()));
}
