/* global chrome */
export function getActiveTabMentionState(input) {
  const text = String(input || "");
  const match = text.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const atOffset = match[0].lastIndexOf("@");
  const start = match.index + atOffset;
  return {
    start,
    end: text.length,
    query: match[2] || ""
  };
}

export function isHttpTab(tab) {
  return typeof tab?.id === "number" && /^https?:\/\//i.test(tab?.url || "");
}

export function serializeMentionTab(tab) {
  return {
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    windowId: tab.windowId,
    favIconUrl: tab.favIconUrl || ""
  };
}

export function serializeMentionSkill(skill) {
  return {
    path: String(skill?.path || "").trim(),
    name: String(skill?.name || "").trim(),
    description: String(skill?.description || "").trim()
  };
}

export function filterMentionTabs(tabs, query, selectedTabs) {
  const selectedIds = new Set((selectedTabs || []).map(tab => tab.id));
  const normalizedQuery = String(query || "").trim().toLowerCase();
  return (tabs || [])
    .filter(tab => !selectedIds.has(tab.id))
    .filter(tab => {
      if (!normalizedQuery) return true;
      return `${tab.title || ""} ${tab.url || ""} ${tab.id}`.toLowerCase().includes(normalizedQuery);
    })
    .slice(0, 12);
}

export async function queryHttpTabsForMention() {
  if (!chrome?.tabs?.query) return [];
  const tabs = await chrome.tabs.query({});
  return (Array.isArray(tabs) ? tabs : []).filter(isHttpTab).map(serializeMentionTab);
}

export function buildUserInjectionMeta(tabs, skills) {
  const normalizedTabs = (tabs || []).map(serializeMentionTab).filter(tab => tab.id);
  const normalizedSkills = (skills || []).map(serializeMentionSkill).filter(skill => skill.path);
  if (normalizedTabs.length === 0 && normalizedSkills.length === 0) return null;
  return {
    tabs: normalizedTabs,
    skills: normalizedSkills
  };
}

export function buildInjectedUserText(text, injectionMeta) {
  const body = String(text || "").trim() || "请根据我指定的上下文回答。";
  const tabLines = (injectionMeta?.tabs || []).map(tab =>
    `- tabId: ${tab.id}; title: ${tab.title || "未命名标签页"}; url: ${tab.url}`
  );
  const skillLines = (injectionMeta?.skills || []).map(skill =>
    `- directoryName: ${skill.path}; name: ${skill.name || skill.path}; description: ${skill.description || ""}`
  );
  const parts = [body];
  if (tabLines.length > 0) {
    parts.push(
      "",
      "用户在输入框中明确 @ 选择了以下已打开的浏览器标签页。回答时应优先把这些 tabId 视为用户指定目标；如需读取页面内容，请直接对对应 tabId 使用 tab_extract 等浏览器工具：",
      ...tabLines
    );
  }
  if (skillLines.length > 0) {
    parts.push(
      "",
      "用户在输入框中明确选择了以下 skill。请优先使用这些 skill 来回答接下来的问题或完成任务；需要完整 workflow 时，使用 skill-bridge 的 get_skill_detail 读取对应 directoryName：",
      ...skillLines
    );
  }
  return parts.join("\n");
}
