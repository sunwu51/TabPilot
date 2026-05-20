/* global chrome */
import { textComplete, getLLMConfigForMemory } from "../llm/providers/textComplete";

// ==================== Storage keys ====================

const KEY_PROFILE_SUMMARY = "user_profile_summary";  // string
const KEY_META = "user_profile_meta";
// meta shape: { enabled?: boolean }

// ==================== Meta helpers ====================

async function getProfileMeta() {
  const { [KEY_META]: meta } = await chrome.storage.local.get({ [KEY_META]: {} });
  return meta;
}

async function saveProfileMeta(patch) {
  const meta = await getProfileMeta();
  await chrome.storage.local.set({ [KEY_META]: { ...meta, ...patch } });
}

export async function isProfileEnabled() {
  const meta = await getProfileMeta();
  return meta.enabled !== false;
}

export async function setProfileEnabled(enabled) {
  await saveProfileMeta({ enabled });
}

// ==================== Profile summary ====================

export async function getProfileSummary() {
  const { [KEY_PROFILE_SUMMARY]: s } = await chrome.storage.local.get({ [KEY_PROFILE_SUMMARY]: "" });
  return typeof s === "string" ? s : "";
}

async function saveProfileSummary(summary) {
  await chrome.storage.local.set({ [KEY_PROFILE_SUMMARY]: summary });
}

// ==================== Analyze recent browsing history ====================

const MAX_DOMAIN_STR_CHARS = 100_000;

/**
 * Query the last 48h of browser history, deduplicate by hostname,
 * truncate to MAX_DOMAIN_STR_CHARS, then call LLM to update the profile summary.
 * Returns true if the LLM was called, false if skipped.
 */
export async function analyzeRecentHistory() {
  if (!(await isProfileEnabled())) return false;

  const config = await getLLMConfigForMemory();
  if (!config) return false;

  const startTime = Date.now() - 48 * 60 * 60 * 1000;
  const items = await chrome.history.search({ text: "", maxResults: 5000, startTime });

  const hostnames = new Set();
  for (const item of items) {
    try {
      const url = new URL(item.url);
      if (url.hostname) hostnames.add(url.hostname);
    } catch { /* skip malformed URLs */ }
  }

  if (hostnames.size === 0) return false;

  let domainList = [...hostnames].sort().join(", ");
  if (domainList.length > MAX_DOMAIN_STR_CHARS) {
    domainList = domainList.slice(0, MAX_DOMAIN_STR_CHARS);
    const lastComma = domainList.lastIndexOf(", ");
    if (lastComma > 0) domainList = domainList.slice(0, lastComma);
  }

  await _updateProfileFromDomains(domainList);
  return true;
}

async function _updateProfileFromDomains(domainList) {
  const config = await getLLMConfigForMemory();
  if (!config) return;

  const prevSummary = await getProfileSummary();

  const userContent = prevSummary
    ? `【已有用户画像】${prevSummary}\n\n【新增访问域名】${domainList}`
    : `【访问域名】${domainList}`;

  const summary = await textComplete(config, [
    {
      role: "system",
      content:
        "你是一个用户兴趣分析员。根据用户访问的网站域名，推断其个人兴趣爱好、常用工具、关注领域等。" +
        "聚焦于「这个人平时喜欢什么、关注什么」，例如：游戏、编程、设计、财经、动漫等方向。" +
        "如果提供了已有画像，请融合新信息，更新为一句更完整的描述。" +
        "输出格式：一句简洁的中文，直接输出，不要任何前缀或解释。" +
        "示例：常访问 GitHub、Stack Overflow，关注前端技术，玩 Steam 游戏，偶尔看 B 站视频。",
    },
    { role: "user", content: userContent },
  ]);

  await saveProfileSummary(summary);
}

// ==================== System prompt injection ====================

export async function formatProfileForSystemPrompt() {
  if (!(await isProfileEnabled())) return "";

  const summary = await getProfileSummary();
  if (!summary) return "";

  return (
    "\n\n--- User Profile (auto-generated from browsing history, treat as background context) ---\n" +
    summary +
    "\n--- End of User Profile ---"
  );
}
