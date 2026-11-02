/* global chrome */
import { chromeStorageVfs } from "./chromeStorageVfs";
import { getStashVfsPath, migrateLegacyStashesToVfs } from "./stashVfs";

function pageUrl(page, key, value) {
  const url = new URL(chrome.runtime.getURL(page));
  url.searchParams.set(key, value);
  return url.toString();
}

export async function listVfsEntries({ path = "/", recursive = false } = {}) {
  await migrateLegacyStashesToVfs();
  const directory = chromeStorageVfs.normalizePath(path);
  const entries = await chromeStorageVfs.readdir(directory, { recursive });
  const projects = new Map();
  const annotated = await Promise.all(entries.map(async entry => {
    const result = { ...entry, kind: entry.type === "directory" ? "directory" : "text" };
    const match = entry.path.match(/^\/(playgrounds|webide)\/([a-zA-Z0-9_-]{1,128})(?:\/|$)/);
    if (match) {
      const [, group, id] = match;
      const root = `/${group}/${id}`;
      if (!projects.has(root)) {
        projects.set(root, chromeStorageVfs.readJson(`${root}/.project.json`).catch(error => {
          if (["ENOENT", "EBADJSON"].includes(error?.code)) return null;
          throw error;
        }));
      }
      const metadata = await projects.get(root);
      if (metadata?.id === id) {
        result.kind = group === "playgrounds" ? "playground" : "webide";
        result.projectId = id;
        result.projectRoot = root;
        result.url = pageUrl(group === "playgrounds" ? "playground-host.html" : "webide-host.html", "id", id);
      }
    } else if (entry.type === "file" && /^\/stashes\/[^/]+\.json$/.test(entry.path)) {
      try {
        const stash = await chromeStorageVfs.readJson(entry.path);
        if (typeof stash?.title === "string" && getStashVfsPath(stash.title) === entry.path && typeof stash.info === "string") {
          result.kind = "stash";
          result.title = stash.title;
          result.url = pageUrl("stash.html", "title", stash.title);
        }
      } catch (error) {
        if (error?.code !== "EBADJSON" && error?.code !== "ENOENT") throw error;
      }
    }
    return result;
  }));
  return { path: directory, recursive, entries: annotated };
}
