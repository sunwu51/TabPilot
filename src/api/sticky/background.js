/* global chrome */
import { PIN_COMMAND, loadPrefs, pinTab, pinUrl, reconcileStickies } from "./store";
import { chromeStorageVfs, VFS_INDEX_KEY, VFS_STORAGE_PREFIX } from "../../utils/chromeStorageVfs";
import { SCRIPTS_DIR, _execEvalJs } from "../llm/tools/builtins/evalAndPlayground";

const MENU_ROOT = "tabpilot-context";
const MENU_SCRIPTS = "tabpilot-run-scripts";
const SCRIPT_MENU_PREFIX = "tabpilot-run-script:";
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
    } else if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(SCRIPT_MENU_PREFIX) && tab?.id != null) {
      const path = info.menuItemId.slice(SCRIPT_MENU_PREFIX.length);
      if (path.startsWith(`${SCRIPTS_DIR}/`) && /\.m?js$/i.test(path)) {
        void runScriptFromBackground(tab.id, path);
      }
    }
  });

  // Keep labels and saved scripts current while the worker is running.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes[LOCALE_KEY] || changes[VFS_INDEX_KEY]
      || Object.keys(changes).some(key => key.startsWith(VFS_STORAGE_PREFIX)))) {
      void setupContextMenus();
    }
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

// Serialize rebuilds so overlapping storage events cannot create duplicate IDs.
let menuUpdates = Promise.resolve();
function setupContextMenus() {
  menuUpdates = menuUpdates.then(rebuildContextMenus).catch(error => {
    console.warn("Could not refresh context menus:", error);
  });
  return menuUpdates;
}

async function rebuildContextMenus() {
  if (!chrome.contextMenus) return;
  const zh = (await menuLocale()) === "zh";
  let scripts = [];
  try {
    scripts = (await chromeStorageVfs.readdir(SCRIPTS_DIR, { recursive: true }))
      .filter(entry => entry.type === "file" && /\.m?js$/i.test(entry.path)
        && (entry.expireAt < 0 || entry.expireAt > Date.now()));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await new Promise(resolve => chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    resolve();
  }));
  const create = properties => new Promise(resolve => {
    chrome.contextMenus.create(properties, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  const contexts = ["page", "link", "selection", "image", "video", "audio", "frame", "editable"];
  await create({ id: MENU_ROOT, title: "TabPilot", contexts });
  await create({
    id: MENU_PAGE,
    parentId: MENU_ROOT,
    title: zh ? "添加到粘贴板" : "Add to sticky board",
    contexts: ["page", "selection", "image", "video", "audio", "frame", "editable"],
  });
  await create({
    id: MENU_LINK,
    parentId: MENU_ROOT,
    title: zh ? "添加链接到粘贴板" : "Add link to sticky board",
    contexts: ["link"],
  });
  await create({
    id: MENU_SCRIPTS,
    parentId: MENU_ROOT,
    title: zh ? "运行脚本（空参）" : "Run script (no arguments)",
    contexts,
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
  if (!scripts.length) {
    await create({
      id: `${MENU_SCRIPTS}-empty`, parentId: MENU_SCRIPTS,
      title: zh ? "暂无可运行的脚本" : "No runnable scripts", enabled: false, contexts,
    });
  }
  for (const script of scripts) {
    await create({
      id: `${SCRIPT_MENU_PREFIX}${script.path}`,
      parentId: MENU_SCRIPTS,
      title: script.path.slice(SCRIPTS_DIR.length + 1).replace(/&/g, "&&"),
      contexts,
    });
  }
}

async function runScriptFromBackground(tabId, path) {
  try {
    const result = await _execEvalJs({ tabId, path });
    if (result.error) {
      console.warn("Context-menu script failed:", path, result.error);
      await flashBadge(tabId, "!");
    } else {
      await flashBadge(tabId, "✓");
    }
  } catch (error) {
    console.warn("Context-menu script failed:", path, error);
    await flashBadge(tabId, "!");
  }
}

async function flashBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    }, 1500);
  } catch { /* badge is cosmetic */ }
}
