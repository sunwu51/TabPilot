import { serializeMentionSkill } from "./tabMention";
export const SLASH_COMMANDS = [
  {
    id: "mem",
    name: "/mem",
    titleKey: "slashMemoryTitle",
    descriptionKey: "slashMemoryDescription"
  },
  {
    id: "recall_mem",
    name: "/recall_mem",
    titleKey: "slashRecallMemoryTitle",
    descriptionKey: "slashRecallMemoryDescription"
  },
  {
    id: "compact",
    name: "/compact",
    titleKey: "slashCompactTitle",
    descriptionKey: "slashCompactDescription"
  },
  {
    id: "clear",
    name: "/clear",
    titleKey: "slashClearTitle",
    descriptionKey: "slashClearDescription"
  }
];

/**
 * Main Agent chat panel with session management.
 * - Auto-saves conversation to chrome.storage.local
 * - Toolbar at top: new session / title / history dropdown
 * - Restores last session on mount
 */
export function shouldOpenSlashCommand(input) {
  return /^\/[a-zA-Z0-9_-]*$/.test(String(input || "").trimStart());
}

export function filterSlashCommands(commands, skills, selectedSkills, input, translate = key => key) {
  const query = String(input || "").trimStart().replace(/^\//, "").toLowerCase();
  const selectedSkillPaths = new Set((selectedSkills || []).map(skill => skill.path));
  const builtins = (commands || [])
    .map(command => ({
      ...command,
      title: translate(command.titleKey || command.title || ""),
      description: translate(command.descriptionKey || command.description || "")
    }))
    .filter(command => {
      if (!query) return true;
      return command.id.includes(query) || command.name.toLowerCase().includes(query) || command.title.toLowerCase().includes(query);
    });
  const skillCommands = (skills || [])
    .filter(skill => skill.enabled !== false)
    .map(serializeMentionSkill)
    .filter(skill => skill.path && !selectedSkillPaths.has(skill.path))
    .filter(skill => {
      if (!query) return true;
      return `${skill.name || ""} ${skill.path || ""} ${skill.description || ""}`.toLowerCase().includes(query);
    })
    .slice(0, 20)
    .map(skill => ({
      id: `skill:${skill.path}`,
      type: "skill",
      skill,
      name: `/${skill.name || skill.path}`,
      title: skill.name || skill.path,
      description: skill.description || `使用 skill: ${skill.path}`
    }));
  return [...builtins, ...skillCommands];
}
export function buildMemoryCommandPrompt() {
  return [
    "请总结本次对话中对未来有用、稳定、值得长期保存的信息。",
    "请使用内置 memory_save 工具逐条保存值得长期保留的信息。memory_save 会根据 scope、type 和稳定的 subject 自动新增或更新；同一事实请复用 subject，避免产生重复记忆。",
    "为每条记忆生成简洁的 summary、完整但精炼的 content、明确的 entities，以及 5-12 个未来可能用于召回的 keywords。",
    "只保存用户偏好、长期项目背景、稳定决策、反复会用到的上下文或纠错后的规则。不要保存临时状态、一次性问题、明显过期的信息或敏感凭据。",
    "完成后请简要告诉我保存或更新了什么；如果没有值得保存的信息，请不要调用 memory_save，并明确说明。"
  ].join("\n");
}

export function buildRecallMemoryCommandPrompt() {
  return [
    "请根据当前对话、当前任务、用户最近的问题和已知项目上下文，检索可能相关的长期记忆。",
    "请使用内置 memory_search 工具检索。查询应包含当前任务中有区分度的项目名、模块、产品、人物、错误码、症状、偏好、决策或约束，不要只使用“上次”或“之前”这样的模糊词。",
    "检索查询应简洁，包含当前任务里的关键项目名、模块、功能、用户偏好、决策或约束。不要为临时网页状态、一次性事实或最新信息使用记忆召回。",
    "完成后请把召回到的相关记忆简要整理到当前上下文，并说明哪些内容会影响接下来的回答或执行；如果 memory_search 没有返回结果，请明确说明没有找到足够相关的记忆。"
  ].join("\n");
}
