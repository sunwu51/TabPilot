import { connectMcpServer, listMcpResources, readMcpResource } from "../../../../api/mcp";

export async function loadSkillsIndexFromSkillStation(serverUrl) {
  const normalizedServerUrl = normalizeSkillStationUrl(serverUrl);
  const connection = await connectMcpServer(normalizedServerUrl, {});
  if (connection.error) {
    throw new Error(connection.error);
  }
  const resources = await listMcpResources(normalizedServerUrl);
  const skillsIndex = resources.find(resource => resource?.uri === "skills://index");
  if (!skillsIndex) {
    throw new Error("skill-bridge 未暴露 skills://index 资源");
  }

  const resourceResult = await readMcpResource(normalizedServerUrl, {}, "skills://index");
  return parseLoadedSkillsResponse(extractResourceText(resourceResult));
}

export function parseLoadedSkillsResponse(text) {
  const payloadText = extractJsonPayload(text);
  let payload;

  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    throw new Error("Skills 索引返回的不是合法 JSON");
  }

  if (payload?.error) {
    throw new Error(String(payload.error));
  }

  const rawSkills = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.skills) ? payload.skills : null);

  if (!rawSkills) {
    throw new Error("Skills 索引缺少 skills 数组");
  }

  return rawSkills
    .map(skill => ({
      path: String(skill?.directoryName || skill?.path || "").trim().replace(/\\/g, "/").replace(/^\.?\//, ""),
      name: String(skill?.name || "").trim(),
      description: String(skill?.description || "").trim(),
      header: {
        ...(skill?.metadata && typeof skill.metadata === "object" ? skill.metadata : {}),
        ...(skill?.header && typeof skill.header === "object" ? skill.header : {})
      }
    }))
    .filter(skill => !!skill.path);
}

export async function loadSkillStationTools(serverUrl, bridgeToolSettings = {}) {
  const normalizedServerUrl = normalizeSkillStationUrl(serverUrl);
  const result = await connectMcpServer(normalizedServerUrl, {});
  if (result.error) {
    throw new Error(result.error);
  }

  const tools = Array.isArray(result.tools) ? result.tools : [];
  const hasGetSkillDetail = tools.some(tool => tool?.name === "get_skill_detail");
  if (!hasGetSkillDetail) {
    throw new Error("skill-bridge 缺少 get_skill_detail 工具");
  }

  return tools.map(tool => ({
    ...tool,
    _serverId: "skill_bridge",
    _serverName: "skill_bridge",
    _serverUrl: normalizedServerUrl,
    _serverHeaders: {},
    _dangerous: resolveSkillBridgeToolDangerous(tool.name, bridgeToolSettings),
    _toolCallName: `mcp_skill_bridge_${tool.name}`
  }));
}

export function resolveSkillBridgeToolDangerous(toolName, bridgeToolSettings = {}) {
  const normalizedToolName = String(toolName || "").trim();
  const explicitDangerous = bridgeToolSettings?.[normalizedToolName]?.dangerous;
  if (explicitDangerous != null) {
    return !!explicitDangerous;
  }
  return normalizedToolName === "shell";
}

export function normalizeSkillStationUrl(serverUrl) {
  return String(serverUrl || "").trim();
}

export function extractResourceText(resourceResult) {
  const contents = Array.isArray(resourceResult?.contents) ? resourceResult.contents : [];
  const texts = contents
    .map(item => item?.text)
    .filter(text => typeof text === "string" && text.trim().length > 0);

  if (texts.length === 0) {
    throw new Error("skills://index 返回为空");
  }

  return texts.join("\n");
}

export function mergeMcpToolLists(primaryTools, secondaryTools) {
  const map = new Map();
  for (const tool of [...(primaryTools || []), ...(secondaryTools || [])]) {
    if (!tool?._toolCallName) continue;
    map.set(tool._toolCallName, tool);
  }
  return [...map.values()];
}

export function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Skills 索引返回为空");
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  if (raw.startsWith("{") || raw.startsWith("[")) return raw;

  const firstArrayStart = raw.indexOf("[");
  const lastArrayEnd = raw.lastIndexOf("]");
  if (firstArrayStart >= 0 && lastArrayEnd > firstArrayStart) {
    return raw.slice(firstArrayStart, lastArrayEnd + 1);
  }

  const firstObjectStart = raw.indexOf("{");
  const lastObjectEnd = raw.lastIndexOf("}");
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    return raw.slice(firstObjectStart, lastObjectEnd + 1);
  }

  throw new Error("未找到可解析的 JSON 输出");
}
