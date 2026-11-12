/* global chrome */
import { PIN_COMMAND, loadPrefs, pinTab, pinUrl, reconcileStickies } from "./store";

const MENU_PAGE = "sticky-pin-page";
const MENU_LINK = "sticky-pin-link";
const LOCALE_KEY = "uiLocale";

/**
 * Service-worker side of the sticky board: keeps notes bound to their tabs
 * while the side panel is closed, and handles the pin keyboard shortcut and
 * the right-click menu entries.
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
  // Rebuilt every time the service worker starts rather than only on install,
  // so the entries exist no matter how the extension was (re)loaded.
  void setupContextMenus();

  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command !== PIN_COMMAND || !tab) return;
    void pinFromBackground(tab, laneId => pinTab(tab, { laneId }));
  });

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_PAGE && tab) {
      void pinFromBackground(tab, laneId => pinTab(tab, { laneId }));
    } else if (info.menuItemId === MENU_LINK && info.linkUrl) {
      void pinFromBackground(tab, laneId => pinUrl(info.linkUrl, { laneId }));
    }
  });

  // Keep the menu labels in the language chosen in settings.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[LOCALE_KEY]) void setupContextMenus();
  });
}

/** New notes go to the lane that is selected on the board, like the button does. */
async function pinFromBackground(tab, pin) {
  try {
    const { activeLane } = await loadPrefs();
    const laneId = activeLane && activeLane !== "all" && activeLane !== "none" ? activeLane : null;
    await pin(laneId);
    if (tab?.id != null) await flashBadge(tab.id, "📌");
  } catch { /* nothing useful to report from the background */ }
}

async function menuLocale() {
  try {
    const { [LOCALE_KEY]: stored } = await chrome.storage.local.get({ [LOCALE_KEY]: "" });
    if (stored === "zh" || stored === "en") return stored;
  } catch { /* fall back to the browser language */ }
  return String(chrome.i18n?.getUILanguage?.() || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

async function setupContextMenus() {
  if (!chrome.contextMenus) return;
  const zh = (await menuLocale()) === "zh";
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: zh ? "把此页面贴到便利贴" : "Stick this page to the board",
      contexts: ["page"],
    }, () => void chrome.runtime.lastError);
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: zh ? "把此链接贴到便利贴" : "Stick this link to the board",
      contexts: ["link"],
    }, () => void chrome.runtime.lastError);
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
