import { serializeMentionSkill } from "./tabMention";
export const SLASH_COMMANDS = [
  {
    id: "mem",
    name: "/mem",
    title: "总结到记忆",
    description: "提炼本次对话中对未来有用的信息，并在有记忆工具时保存。"
  },
  {
    id: "recall_mem",
    name: "/recall_mem",
    title: "召回相关记忆",
    description: "根据当前对话检索长期记忆，并把相关信息拉取到当前上下文。"
  },
  {
    id: "clear",
    name: "/clear",
    title: "清空当前会话",
    description: "与工具栏清空按钮相同，会清空消息、计划和关键词。"
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

export function filterSlashCommands(commands, skills, selectedSkills, input) {
  const query = String(input || "").trimStart().replace(/^\//, "").toLowerCase();
  const selectedSkillPaths = new Set((selectedSkills || []).map(skill => skill.path));
  const builtins = (commands || [])
    .filter(command => {
      if (!query) return true;
      return command.id.includes(query) || command.name.toLowerCase().includes(query) || command.title.toLowerCase().includes(query);
    });
  const skillCommands = (skills || [])
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
    "如果当前可用工具中存在长期记忆/保存记忆能力，请使用相应工具保存这些信息；工具名称可能被 MCP 或系统加前缀，请根据工具描述判断。",
    "只保存用户偏好、长期项目背景、稳定决策、反复会用到的上下文或纠错后的规则。不要保存临时状态、一次性问题、明显过期的信息或敏感凭据。",
    "完成后请简要告诉我保存了什么；如果没有可用的记忆保存工具，或者没有值得保存的信息，也请明确说明。"
  ].join("\n");
}

export function buildRecallMemoryCommandPrompt() {
  return [
    "请根据当前对话、当前任务、用户最近的问题和已知项目上下文，检索可能相关的长期记忆。",
    "如果当前可用工具中存在长期记忆检索/召回/搜索能力，请使用相应工具拉取相关记忆；工具名称可能被 MCP 或系统加前缀，请根据工具名称和描述判断。",
    "检索查询应简洁，包含当前任务里的关键项目名、模块、功能、用户偏好、决策或约束。不要为临时网页状态、一次性事实或最新信息使用记忆召回。",
    "完成后请把召回到的相关记忆简要整理到当前上下文，并说明哪些内容会影响接下来的回答或执行；如果没有可用的记忆检索工具或没有相关记忆，也请明确说明。"
  ].join("\n");
}
