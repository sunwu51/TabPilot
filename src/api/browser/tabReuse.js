/* global chrome */

const REUSE_DOMAIN_POLICIES_KEY = "reuseDomainPolicies";

export async function isTabReuseEnabled() {
  const { reuse } = await chrome.storage.local.get({ reuse: false });
  return !!reuse;
}

export function getReuseDomainKey(url) {
  const normalizedUrl = normalizeReusableUrl(url);
  if (!normalizedUrl) return "";

  try {
    return new URL(normalizedUrl).hostname || "";
  } catch (_error) {
    return "";
  }
}

export function normalizeReusableUrl(url) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return raw.split("#")[0];
  }
}

export async function findReusableTab(url, { excludeTabId } = {}) {
  const normalizedUrl = normalizeReusableUrl(url);
  if (!normalizedUrl) return null;

  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => {
    if (!tab?.id || tab.id === excludeTabId) return false;
    const candidateUrl = normalizeReusableUrl(tab.pendingUrl || tab.url);
    return candidateUrl === normalizedUrl;
  }) || null;
}

export async function getReuseDomainPolicies() {
  const { [REUSE_DOMAIN_POLICIES_KEY]: reuseDomainPolicies } = await chrome.storage.local.get({
    [REUSE_DOMAIN_POLICIES_KEY]: {}
  });
  return reuseDomainPolicies || {};
}

export async function getReuseDomainPolicy(domainKey) {
  if (!domainKey) return "";
  const policies = await getReuseDomainPolicies();
  const value = policies[domainKey];
  return value === "reuse" || value === "keep" ? value : "";
}

export async function setReuseDomainPolicy(domainKey, decision) {
  if (!domainKey) return;
  const policies = await getReuseDomainPolicies();

  if (decision === "reuse" || decision === "keep") {
    policies[domainKey] = decision;
  } else {
    delete policies[domainKey];
  }

  await chrome.storage.local.set({ [REUSE_DOMAIN_POLICIES_KEY]: policies });
}

export async function clearReuseDomainPolicies() {
  await chrome.storage.local.set({ [REUSE_DOMAIN_POLICIES_KEY]: {} });
}

export async function focusReusableTab(tab) {
  if (!tab?.id) return null;

  await chrome.windows.update(tab.windowId, { focused: true });
  const nextTab = await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(nextTab.windowId, { focused: true });
  return nextTab;
}
