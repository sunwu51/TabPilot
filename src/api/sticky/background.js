/* global chrome */
import { PIN_COMMAND, loadPrefs, pinTab, reconcileStickies } from "./store";

/**
 * Service-worker side of the sticky board: keeps notes bound to their tabs
 * while the side panel is closed, and handles the pin keyboard shortcut.
 */
export function registerStickyBackground() {
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reconcileStickies().catch(() => {});
    }, 150);
  };

  chrome.tabs.onUpdated.addListener((_tabId, info) => {
    if (info.url || info.title || info.favIconUrl || info.status === "complete") schedule();
  });
  chrome.tabs.onRemoved.addListener(schedule);
  chrome.tabs.onReplaced?.addListener(schedule);
  chrome.runtime.onStartup.addListener(schedule);
  chrome.runtime.onInstalled.addListener(schedule);

  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command !== PIN_COMMAND || !tab) return;
    void (async () => {
      try {
        const { activeLane } = await loadPrefs();
        const laneId = activeLane && activeLane !== "all" && activeLane !== "none" ? activeLane : null;
        await pinTab(tab, { laneId });
        await flashBadge(tab.id, "📌");
      } catch { /* nothing useful to report from the background */ }
    })();
  });
}

async function flashBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    }, 1500);
  } catch { /* badge is cosmetic */ }
}
