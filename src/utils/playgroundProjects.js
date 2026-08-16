/* global chrome */
import {
  chromeStorageVfs,
  DEFAULT_VFS_MAX_FILE_BYTES
} from "./chromeStorageVfs";

export const PLAYGROUND_FILE_NAMES = Object.freeze(["index.html", "style.css", "script.js"]);
export const PLAYGROUND_STORAGE_PREFIX = "htmlPlaygroundProject:";
export const MAX_PLAYGROUND_FILE_BYTES = DEFAULT_VFS_MAX_FILE_BYTES;
export const DEFAULT_PLAYGROUND_TTL_MS = 24 * 60 * 60 * 1000;

const SOURCE_TO_FILE = Object.freeze({
  html: "index.html",
  css: "style.css",
  js: "script.js"
});

function normalizeProjectId(projectId) {
  const value = String(projectId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid playgroundId");
  return value;
}

function projectDirectory(projectId) {
  return `/playgrounds/${normalizeProjectId(projectId)}`;
}

function projectMetadataPath(projectId) {
  return `${projectDirectory(projectId)}/.project.json`;
}

export function getPlaygroundFilePath(projectId, file) {
  return `${projectDirectory(projectId)}/${normalizePlaygroundFileName(file)}`;
}

export function getPlaygroundProjectPath(projectId) {
  return projectDirectory(projectId);
}

function legacyProjectStorageKey(projectId) {
  return `${PLAYGROUND_STORAGE_PREFIX}${normalizeProjectId(projectId)}`;
}

export function normalizePlaygroundFileName(file) {
  const value = String(file || "").trim();
  const normalized = SOURCE_TO_FILE[value] || value;
  if (!PLAYGROUND_FILE_NAMES.includes(normalized)) {
    throw new Error(`Unknown playground file: ${value || "(empty)"}`);
  }
  return normalized;
}

function createProjectId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `pg_${uuid.replace(/-/g, "")}`;
  return `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeExpireAt(expireAt, now) {
  if (expireAt === -1) return -1;
  const value = Number(expireAt);
  return Number.isFinite(value) && value > now ? value : now + DEFAULT_PLAYGROUND_TTL_MS;
}

async function writeProjectFiles(projectId, files, metadata, { overwrite = false } = {}) {
  const writtenPaths = [];
  try {
    for (const file of PLAYGROUND_FILE_NAMES) {
      const fileStat = await chromeStorageVfs.writeFile(getPlaygroundFilePath(projectId, file), files[file], {
        overwrite,
        expireAt: metadata.expireAt
      });
      writtenPaths.push(fileStat.path);
    }
    const metadataStat = await chromeStorageVfs.writeJson(projectMetadataPath(projectId), metadata, {
      overwrite,
      expireAt: metadata.expireAt
    });
    writtenPaths.push(metadataStat.path);
  } catch (error) {
    if (!overwrite) await Promise.all(writtenPaths.map(path => chromeStorageVfs.unlink(path).catch(() => undefined)));
    throw error;
  }
}

async function loadVfsProject(projectId) {
  const metadataPath = projectMetadataPath(projectId);
  const filePaths = PLAYGROUND_FILE_NAMES.map(file => getPlaygroundFilePath(projectId, file));
  let records;
  try {
    records = await chromeStorageVfs.readFilesWithStats([metadataPath, ...filePaths]);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let metadata;
  try {
    metadata = JSON.parse(records[metadataPath].content);
  } catch (error) {
    const invalidJson = new Error(`Invalid playground metadata: ${projectId}`);
    invalidJson.cause = error;
    throw invalidJson;
  }
  const files = {};
  const fileRevisions = {};
  PLAYGROUND_FILE_NAMES.forEach((file, index) => {
    const record = records[filePaths[index]];
    files[file] = record.content;
    fileRevisions[file] = record.stat.revision;
  });
  return {
    ...metadata,
    id: normalizeProjectId(projectId),
    files,
    fileRevisions,
    revision: 1 + Object.values(fileRevisions).reduce((sum, revision) => sum + revision - 1, 0)
  };
}

async function migrateLegacyProject(projectId) {
  const key = legacyProjectStorageKey(projectId);
  const stored = await chrome.storage.local.get(key);
  const legacy = stored[key];
  if (!legacy || typeof legacy !== "object") return null;
  const legacyFiles = legacy.files && typeof legacy.files === "object" ? legacy.files : {};
  const files = {
    "index.html": String(legacyFiles["index.html"] || ""),
    "style.css": String(legacyFiles["style.css"] || ""),
    "script.js": String(legacyFiles["script.js"] || "")
  };
  const now = Date.now();
  await writeProjectFiles(projectId, files, {
    id: normalizeProjectId(projectId),
    createdAt: Number(legacy.createdAt) || now,
    updatedAt: Number(legacy.updatedAt) || now,
    expireAt: normalizeExpireAt(legacy.expireAt, now)
  }, { overwrite: true });
  const migrated = await loadVfsProject(projectId);
  if (!migrated) throw new Error(`Failed to migrate playground project: ${projectId}`);
  await chrome.storage.local.remove(key);
  return migrated;
}

export async function createPlaygroundProject({ html = "", css = "", js = "", expireAt } = {}) {
  let projectId = createProjectId();
  while (await chromeStorageVfs.exists(projectMetadataPath(projectId))) projectId = createProjectId();
  const now = Date.now();
  const files = {
    "index.html": String(html || ""),
    "style.css": String(css || ""),
    "script.js": String(js || "")
  };
  await writeProjectFiles(projectId, files, {
    id: projectId,
    createdAt: now,
    updatedAt: now,
    expireAt: normalizeExpireAt(expireAt, now)
  });
  return loadVfsProject(projectId);
}

export async function getPlaygroundProject(projectId) {
  const normalizedId = normalizeProjectId(projectId);
  return await loadVfsProject(normalizedId) || migrateLegacyProject(normalizedId);
}

export async function requirePlaygroundProject(projectId) {
  const project = await getPlaygroundProject(projectId);
  if (!project) throw new Error(`Playground project not found: ${projectId}`);
  return project;
}

export async function readPlaygroundFile({ playgroundId, file, startLine, endLine } = {}) {
  await requirePlaygroundProject(playgroundId);
  const fileName = normalizePlaygroundFileName(file);
  const result = await chromeStorageVfs.readLines(getPlaygroundFilePath(playgroundId, fileName), { startLine, endLine });
  return {
    success: true,
    playgroundId: normalizeProjectId(playgroundId),
    file: fileName,
    content: result.content,
    startLine: result.startLine,
    endLine: result.endLine,
    lineCount: result.lineCount,
    revision: result.revision
  };
}

export async function editPlaygroundFile({ playgroundId, file, content, startLine, endLine, expectedRevision } = {}) {
  await requirePlaygroundProject(playgroundId);
  const fileName = normalizePlaygroundFileName(file);
  const path = getPlaygroundFilePath(playgroundId, fileName);
  const result = await chromeStorageVfs.applyPatch(path, { content, startLine, endLine, expectedRevision });
  const currentContent = await chromeStorageVfs.readFile(path);
  return {
    success: true,
    playgroundId: normalizeProjectId(playgroundId),
    file: fileName,
    startLine: startLine == null ? 1 : Number(startLine),
    endLine: endLine == null ? (startLine == null ? (currentContent === "" ? 0 : currentContent.split("\n").length) : Number(startLine)) : Number(endLine),
    lineCount: currentContent === "" ? 0 : currentContent.split("\n").length,
    revision: result.revision
  };
}

export async function replacePlaygroundFile(projectId, file, content, options) {
  return editPlaygroundFile({ playgroundId: projectId, file, content, ...options });
}

export async function removePlaygroundProject(projectId) {
  const normalizedId = normalizeProjectId(projectId);
  const result = await chromeStorageVfs.unlink(projectDirectory(normalizedId), { recursive: true });
  await chrome.storage.local.remove(legacyProjectStorageKey(normalizedId));
  return result;
}
