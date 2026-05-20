/* global chrome */

const STORAGE_KEY = "agentSkills";

export const EMPTY_AGENT_SKILLS = {
  serverUrl: "",
  loadedAt: 0,
  bridgeToolSettings: {},
  skills: []
};

export async function loadAgentSkills() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: EMPTY_AGENT_SKILLS });
  return normalizeAgentSkills(result[STORAGE_KEY]);
}

export async function saveAgentSkills(agentSkills) {
  const normalized = normalizeAgentSkills(agentSkills);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export function buildSkillsSystemPrompt(agentSkills) {
  const normalized = normalizeAgentSkills(agentSkills);
  if (!normalized.serverUrl) {
    return "";
  }

  if (normalized.skills.length === 0) {
    return (
      `\n\nSkills via skill-bridge:\n` +
      `- The user configured the skill-bridge MCP endpoint ${JSON.stringify(normalized.serverUrl)}.\n` +
      `- Skills index has not been loaded yet.\n` +
      `- When skill details are needed, use the MCP tool mcp_skill_bridge_get_skill_detail (the wrapped MCP tool for get_skill_detail).\n` +
      `- If a skill's full content has already been loaded into the current conversation context, reuse that content directly and do not read the same skill again unless the user explicitly asks to reload it.\n`
    );
  }

  const lines = normalized.skills.map(skill => {
    const parts = [`directoryName=${JSON.stringify(skill.path)}`];
    if (skill.name) parts.push(`name=${JSON.stringify(skill.name)}`);
    if (skill.description) parts.push(`description=${JSON.stringify(skill.description)}`);
    for (const [key, value] of Object.entries(skill.header || {})) {
      if (!value || key === "name" || key === "description") continue;
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
    return `- ${parts.join("; ")}`;
  });

  return (
    `\n\nSkills via skill-bridge:\n` +
    `- The user configured the skill-bridge MCP endpoint ${JSON.stringify(normalized.serverUrl)}.\n` +
    `- The following entries are indexed summaries loaded from the MCP resource skills://index:\n` +
    `${lines.join("\n")}\n` +
    `- When a task matches one of these skills, use the MCP tool mcp_skill_bridge_get_skill_detail with the skill directory name to read the full SKILL.md.\n` +
    `- If a skill's full content has already been loaded into the current conversation context, reuse that content directly and do not read the same skill again unless the user explicitly asks to reload it.\n` +
    `- Do not rely on the summary alone when the task depends on the actual skill workflow.\n`
  );
}

export function normalizeAgentSkills(agentSkills) {
  const serverUrl = normalizeServerUrl(agentSkills?.serverUrl || agentSkills?.rootPath || agentSkills?.rootName || "");
  const loadedAt = Number(agentSkills?.loadedAt || agentSkills?.scannedAt) || 0;
  const bridgeToolSettings = normalizeBridgeToolSettings(agentSkills?.bridgeToolSettings);
  const rawSkills = Array.isArray(agentSkills?.skills) ? agentSkills.skills : [];

  const skills = rawSkills
    .map(skill => ({
      path: normalizeRelativePath(skill?.path || ""),
      name: String(skill?.name || ""),
      description: String(skill?.description || ""),
      header: normalizeHeader(skill?.header)
    }))
    .filter(skill => skill.path)
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    serverUrl,
    loadedAt,
    bridgeToolSettings,
    skills
  };
}

export function mergeAgentSkillsServerUrl(agentSkills, serverUrl) {
  const normalizedCurrent = normalizeAgentSkills(agentSkills);
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  return normalizeAgentSkills({
    serverUrl: normalizedServerUrl,
    loadedAt: normalizedCurrent.serverUrl === normalizedServerUrl ? normalizedCurrent.loadedAt : 0,
    bridgeToolSettings: normalizedCurrent.bridgeToolSettings,
    skills: normalizedCurrent.serverUrl === normalizedServerUrl ? normalizedCurrent.skills : []
  });
}

export function mergeLoadedSkills(_agentSkills, serverUrl, skills) {
  const normalizedCurrent = normalizeAgentSkills(_agentSkills);
  return normalizeAgentSkills({
    serverUrl,
    loadedAt: Date.now(),
    bridgeToolSettings: normalizedCurrent.bridgeToolSettings,
    skills
  });
}

export function mergeBridgeToolDangerous(agentSkills, toolName, dangerous) {
  const normalizedCurrent = normalizeAgentSkills(agentSkills);
  return normalizeAgentSkills({
    ...normalizedCurrent,
    bridgeToolSettings: {
      ...normalizedCurrent.bridgeToolSettings,
      [String(toolName || "").trim()]: {
        dangerous: !!dangerous
      }
    }
  });
}

function normalizeHeader(header) {
  if (!header || typeof header !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(header)) {
    if (!key || value == null || value === "") continue;
    normalized[String(key)] = String(value);
  }
  return normalized;
}

function normalizeServerUrl(serverUrl) {
  return String(serverUrl || "").trim().replace(/\s+/g, "");
}

function normalizeRelativePath(path) {
  return String(path || "").trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

function normalizeBridgeToolSettings(settings) {
  if (!settings || typeof settings !== "object") return {};
  const normalized = {};
  for (const [toolName, value] of Object.entries(settings)) {
    const key = String(toolName || "").trim();
    if (!key) continue;
    normalized[key] = {
      dangerous: !!value?.dangerous
    };
  }
  return normalized;
}
