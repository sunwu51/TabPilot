/* global chrome */
import { chromeStorageVfs } from "../../utils/chromeStorageVfs";
import { SCRIPTS_DIR } from "../llm/tools/builtins/evalAndPlayground";
import drawPenSource from "../../builtinScripts/draw-pen.js.txt?raw";
import devToolsSource from "../../builtinScripts/dev-tools.js.txt?raw";

/** Scripts shipped with the extension; they show up in the right-click "Run script" menu. */
export const BUILTIN_SCRIPTS = [
  { path: `${SCRIPTS_DIR}/builtin/draw-pen.js`, content: drawPenSource },
  { path: `${SCRIPTS_DIR}/builtin/dev-tools.js`, content: devToolsSource }
];

const HASHES_KEY = "builtinScriptHashes";
const BUILTIN_MARKER = "// TabPilot built-in:";

function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h}`;
}

async function readHashes() {
  try {
    const res = await chrome.storage.local.get({ [HASHES_KEY]: {} });
    return res[HASHES_KEY] && typeof res[HASHES_KEY] === "object" ? res[HASHES_KEY] : {};
  } catch {
    return {};
  }
}

/**
 * Install missing built-in scripts and upgrade the ones the user has not edited.
 * A script counts as unedited when it still matches the version we installed last time
 * (tracked by hash), or, for installs that predate tracking, when it still carries the
 * built-in header line. Edited scripts are never overwritten.
 */
export async function ensureBuiltinScripts(scripts = BUILTIN_SCRIPTS) {
  const hashes = await readHashes();
  const changed = [];
  for (const script of scripts) {
    try {
      const nextHash = hashText(script.content);
      if (!(await chromeStorageVfs.exists(script.path))) {
        await chromeStorageVfs.writeFile(script.path, script.content, { overwrite: false });
      } else {
        const current = await chromeStorageVfs.readFile(script.path);
        if (current === script.content) {
          hashes[script.path] = nextHash;
          continue;
        }
        const pristine = hashes[script.path]
          ? hashText(current) === hashes[script.path]
          : String(current).startsWith(BUILTIN_MARKER);
        if (!pristine) continue;
        await chromeStorageVfs.writeFile(script.path, script.content);
      }
      hashes[script.path] = nextHash;
      changed.push(script.path);
    } catch (error) {
      if (error?.code !== "EEXIST") console.warn("Could not install built-in script:", script.path, error);
    }
  }
  try {
    await chrome.storage.local.set({ [HASHES_KEY]: hashes });
  } catch { /* tracking is best-effort */ }
  return changed;
}
