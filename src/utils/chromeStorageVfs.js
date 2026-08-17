/* global chrome */

export const VFS_STORAGE_PREFIX = "vfs:file:";
export const VFS_INDEX_KEY = "vfs:index";
export const VFS_INDEX_VERSION = 2;
export const DEFAULT_VFS_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const VFS_CLEANUP_ALARM_NAME = "vfs-expired-file-cleanup";
export const VFS_CLEANUP_PERIOD_MINUTES = 60;

let fallbackMutationQueue = Promise.resolve();

function createVfsError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function normalizeVfsPath(input) {
  const raw = String(input || "").trim().replace(/\\/g, "/");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw createVfsError("EINVAL", `Path escapes VFS root: ${input}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function storageKey(path) {
  return `${VFS_STORAGE_PREFIX}${encodeURIComponent(normalizeVfsPath(path))}`;
}

function pathFromStorageKey(key) {
  if (!String(key).startsWith(VFS_STORAGE_PREFIX)) return null;
  try {
    return normalizeVfsPath(decodeURIComponent(String(key).slice(VFS_STORAGE_PREFIX.length)));
  } catch {
    return null;
  }
}

function parentPath(path) {
  const normalized = normalizeVfsPath(path);
  if (normalized === "/") return null;
  const index = normalized.lastIndexOf("/");
  return index === 0 ? "/" : normalized.slice(0, index);
}

function baseName(path) {
  const normalized = normalizeVfsPath(path);
  return normalized === "/" ? "/" : normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isWithin(candidate, directory) {
  const path = normalizeVfsPath(candidate);
  const dir = normalizeVfsPath(directory);
  return dir === "/" ? path !== "/" : path.startsWith(`${dir}/`);
}

function assertTextContent(content, maxFileBytes) {
  if (typeof content !== "string") throw createVfsError("EINVAL", "VFS content must be a string");
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > maxFileBytes) {
    throw createVfsError("EFBIG", `File exceeds the ${maxFileBytes}-byte VFS limit`, { byteLength, maxFileBytes });
  }
  return byteLength;
}

function countTextLines(content) {
  return content === "" ? 0 : content.split("\n").length;
}

async function withMutationLock(callback) {
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request("chrome-storage-vfs:mutation", callback);
  }
  const run = fallbackMutationQueue.then(callback, callback);
  fallbackMutationQueue = run.catch(() => undefined);
  return run;
}

function toFileStat(record) {
  return {
    type: "file",
    path: record.path,
    name: baseName(record.path),
    size: Number(record.size) || 0,
    lineCount: Number.isInteger(record.lineCount) ? record.lineCount : countTextLines(record.content || ""),
    expireAt: Number.isFinite(record.expireAt) ? record.expireAt : -1,
    revision: Math.max(1, Number(record.revision) || 1),
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0
  };
}

async function getFileRecord(path) {
  const normalized = normalizeVfsPath(path);
  const key = storageKey(normalized);
  const result = await chrome.storage.local.get(key);
  const record = result[key];
  if (!record || record.type !== "file" || record.path !== normalized) return null;
  return record;
}

function createEmptyIndex() {
  return { version: VFS_INDEX_VERSION, entries: {}, updatedAt: Date.now() };
}

function isValidIndex(index) {
  return index?.version === VFS_INDEX_VERSION && index.entries && typeof index.entries === "object";
}

function setIndexEntry(index, record) {
  index.entries[record.path] = toFileStat(record);
  index.updatedAt = Date.now();
}

function removeIndexEntry(index, path) {
  delete index.entries[normalizeVfsPath(path)];
  index.updatedAt = Date.now();
}

async function loadVfsIndex() {
  const storedIndex = await chrome.storage.local.get(VFS_INDEX_KEY);
  if (isValidIndex(storedIndex[VFS_INDEX_KEY])) return storedIndex[VFS_INDEX_KEY];

  // One-time migration for VFS files created before the index existed.
  const stored = await chrome.storage.local.get(null);
  const index = createEmptyIndex();
  for (const [key, record] of Object.entries(stored)) {
    if (!key.startsWith(VFS_STORAGE_PREFIX) || record?.type !== "file" || typeof record.path !== "string") continue;
    setIndexEntry(index, record);
  }
  await chrome.storage.local.set({ [VFS_INDEX_KEY]: index });
  return index;
}

function getIndexEntries(index) {
  return Object.values(index.entries || {});
}

export function createChromeStorageVfs({ maxFileBytes = DEFAULT_VFS_MAX_FILE_BYTES } = {}) {
  const byteLimit = Math.max(1, Number(maxFileBytes) || DEFAULT_VFS_MAX_FILE_BYTES);

  async function readFileWithStat(path) {
    const normalized = normalizeVfsPath(path);
    const record = await getFileRecord(normalized);
    if (!record) throw createVfsError("ENOENT", `VFS file not found: ${normalized}`, { path: normalized });
    return { content: record.content, stat: toFileStat(record) };
  }

  async function readFile(path) {
    return (await readFileWithStat(path)).content;
  }

  async function readFilesWithStats(paths) {
    const normalizedPaths = [...new Set((paths || []).map(normalizeVfsPath))];
    const keys = normalizedPaths.map(storageKey);
    const stored = await chrome.storage.local.get(keys);
    const result = {};
    for (let index = 0; index < normalizedPaths.length; index += 1) {
      const path = normalizedPaths[index];
      const record = stored[keys[index]];
      if (!record || record.type !== "file" || record.path !== path) {
        throw createVfsError("ENOENT", `VFS file not found: ${path}`, { path });
      }
      result[path] = { content: record.content, stat: toFileStat(record) };
    }
    return result;
  }

  async function writeFile(path, content, { expectedRevision, overwrite = true, expireAt } = {}) {
    const normalized = normalizeVfsPath(path);
    if (normalized === "/") throw createVfsError("EISDIR", "Cannot write to VFS root");
    const size = assertTextContent(content, byteLimit);

    return withMutationLock(async () => {
      const index = await loadVfsIndex();
      const entries = getIndexEntries(index);
      const existing = index.entries[normalized] || null;
      const ancestorFile = entries.find(record => isWithin(normalized, record.path));
      const descendantFile = entries.find(record => isWithin(record.path, normalized));
      if (ancestorFile) throw createVfsError("ENOTDIR", `VFS path ancestor is a file: ${ancestorFile.path}`);
      if (!existing && descendantFile) throw createVfsError("EISDIR", `VFS path is a directory: ${normalized}`);
      if (existing && !overwrite) throw createVfsError("EEXIST", `VFS file already exists: ${normalized}`);
      const currentRevision = existing ? Math.max(1, Number(existing.revision) || 1) : 0;
      if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
        throw createVfsError(
          "ESTALE",
          `VFS revision changed from ${expectedRevision} to ${currentRevision}: ${normalized}`,
          { path: normalized, expectedRevision: Number(expectedRevision), currentRevision }
        );
      }
      const now = Date.now();
      const nextExpireAt = expireAt == null ? (Number.isFinite(existing?.expireAt) ? existing.expireAt : -1) : Number(expireAt);
      if (!Number.isFinite(nextExpireAt)) throw createVfsError("EINVAL", "expireAt must be a Unix millisecond timestamp or -1");
      const record = {
        type: "file",
        path: normalized,
        content,
        size,
        lineCount: countTextLines(content),
        expireAt: nextExpireAt,
        revision: currentRevision + 1,
        createdAt: Number(existing?.createdAt) || now,
        updatedAt: now
      };
      setIndexEntry(index, record);
      await chrome.storage.local.set({
        [storageKey(normalized)]: record,
        [VFS_INDEX_KEY]: index
      });
      return toFileStat(record);
    });
  }

  async function stat(path) {
    const normalized = normalizeVfsPath(path);
    const index = await loadVfsIndex();
    const record = index.entries[normalized];
    if (record) return { ...record };
    const entries = getIndexEntries(index);
    if (normalized === "/" || entries.some(item => isWithin(item.path, normalized))) {
      return { type: "directory", path: normalized, name: baseName(normalized), size: 0, revision: null };
    }
    throw createVfsError("ENOENT", `VFS path not found: ${normalized}`, { path: normalized });
  }

  async function exists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function readdir(path = "/", { recursive = false } = {}) {
    const directory = normalizeVfsPath(path);
    const index = await loadVfsIndex();
    const records = getIndexEntries(index);
    if (index.entries[directory]) {
      throw createVfsError("ENOTDIR", `VFS path is not a directory: ${directory}`);
    }
    const entries = new Map();

    for (const record of records) {
      if (!isWithin(record.path, directory)) continue;
      const relative = directory === "/" ? record.path.slice(1) : record.path.slice(directory.length + 1);
      if (recursive) {
        entries.set(record.path, toFileStat(record));
        continue;
      }
      const firstPart = relative.split("/")[0];
      const childPath = directory === "/" ? `/${firstPart}` : `${directory}/${firstPart}`;
      if (relative.includes("/")) {
        entries.set(childPath, { type: "directory", path: childPath, name: firstPart, size: 0, revision: null });
      } else {
        entries.set(childPath, toFileStat(record));
      }
    }

    if (directory !== "/" && entries.size === 0 && !records.some(record => record.path === directory)) {
      const directoryExists = records.some(record => isWithin(record.path, directory));
      if (!directoryExists) throw createVfsError("ENOENT", `VFS directory not found: ${directory}`);
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function readLines(path, { startLine, endLine } = {}) {
    const normalized = normalizeVfsPath(path);
    const content = await readFile(normalized);
    const fileStat = await stat(normalized);
    const lines = content === "" ? [] : content.split("\n");
    const lineCount = lines.length;
    const firstLine = startLine == null ? 1 : Number(startLine);
    const lastLine = endLine == null ? lineCount : Number(endLine);

    if (!Number.isInteger(firstLine) || firstLine < 1) throw createVfsError("EINVAL", "startLine must be a positive integer");
    if (!Number.isInteger(lastLine) || lastLine < 0) throw createVfsError("EINVAL", "endLine must be a non-negative integer");
    if (lineCount === 0 && (firstLine !== 1 || lastLine !== 0)) throw createVfsError("ERANGE", `${normalized} is empty; its readable range is 1..0`);
    if (lineCount > 0 && firstLine > lineCount) throw createVfsError("ERANGE", `startLine exceeds ${normalized} line count (${lineCount})`);
    if (lineCount > 0 && lastLine < firstLine) throw createVfsError("ERANGE", "endLine must be greater than or equal to startLine");
    const boundedEnd = Math.min(lastLine, lineCount);
    return {
      path: normalized,
      content: lines.slice(firstLine - 1, boundedEnd).join("\n"),
      startLine: firstLine,
      endLine: boundedEnd,
      lineCount,
      revision: fileStat.revision
    };
  }

  async function applyPatch(path, { content, startLine, endLine, expectedRevision } = {}) {
    const normalized = normalizeVfsPath(path);
    if (typeof content !== "string") throw createVfsError("EINVAL", "Patch content must be a string");
    if (startLine == null && endLine == null) {
      return writeFile(normalized, content, { expectedRevision });
    }

    return withMutationLock(async () => {
      const index = await loadVfsIndex();
      const existing = await getFileRecord(normalized);
      if (!existing) throw createVfsError("ENOENT", `VFS file not found: ${normalized}`);
      const currentRevision = Math.max(1, Number(existing.revision) || 1);
      if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
        throw createVfsError("ESTALE", `VFS revision changed from ${expectedRevision} to ${currentRevision}: ${normalized}`, {
          path: normalized,
          expectedRevision: Number(expectedRevision),
          currentRevision
        });
      }
      const lines = existing.content === "" ? [] : existing.content.split("\n");
      const lineCount = lines.length;
      const firstLine = Number(startLine);
      const lastLine = endLine == null ? firstLine : Number(endLine);
      if (!Number.isInteger(firstLine) || firstLine < 1 || firstLine > lineCount + 1) {
        throw createVfsError("ERANGE", `startLine must be an integer between 1 and ${lineCount + 1}`);
      }
      if (!Number.isInteger(lastLine) || lastLine < firstLine - 1 || lastLine > lineCount) {
        throw createVfsError("ERANGE", `endLine must be an integer between ${firstLine - 1} and ${lineCount}`);
      }
      const replacement = content === "" ? [] : content.split("\n");
      lines.splice(firstLine - 1, lastLine - firstLine + 1, ...replacement);
      const nextContent = lines.join("\n");
      const size = assertTextContent(nextContent, byteLimit);
      const now = Date.now();
      const record = {
        ...existing,
        content: nextContent,
        size,
        lineCount: countTextLines(nextContent),
        revision: currentRevision + 1,
        updatedAt: now
      };
      setIndexEntry(index, record);
      await chrome.storage.local.set({
        [storageKey(normalized)]: record,
        [VFS_INDEX_KEY]: index
      });
      return {
        ...toFileStat(record),
        startLine: firstLine,
        endLine: lastLine,
        lineCount: lines.length
      };
    });
  }

  async function editRange(path, { startLine, endLine, originalContent, newContent, expectedRevision } = {}) {
    const normalized = normalizeVfsPath(path);
    if (typeof originalContent !== "string" || typeof newContent !== "string") {
      throw createVfsError("EINVAL", "originalContent and newContent must be strings");
    }

    return withMutationLock(async () => {
      const index = await loadVfsIndex();
      const existing = await getFileRecord(normalized);
      if (!existing) throw createVfsError("ENOENT", `VFS file not found: ${normalized}`);
      const currentRevision = Math.max(1, Number(existing.revision) || 1);
      if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
        throw createVfsError("ESTALE", `VFS revision changed from ${expectedRevision} to ${currentRevision}: ${normalized}`, {
          path: normalized,
          expectedRevision: Number(expectedRevision),
          currentRevision
        });
      }

      const lines = existing.content === "" ? [] : existing.content.split("\n");
      const firstLine = Number(startLine);
      const lastLine = Number(endLine);
      if (!Number.isInteger(firstLine) || !Number.isInteger(lastLine) || firstLine < 1 || lastLine < firstLine || lastLine > lines.length) {
        throw createVfsError("ERANGE", `Line range must be between 1 and ${lines.length}`);
      }
      const actualContent = lines.slice(firstLine - 1, lastLine).join("\n");
      if (actualContent !== originalContent) {
        throw createVfsError("ECONFLICT", `Lines ${firstLine}-${lastLine} content does not match: ${normalized}`, {
          path: normalized,
          startLine: firstLine,
          endLine: lastLine,
          expectedContent: originalContent,
          actualContent
        });
      }
      const replacement = newContent === "" ? [] : newContent.split("\n");
      lines.splice(firstLine - 1, lastLine - firstLine + 1, ...replacement);

      const nextContent = lines.join("\n");
      const size = assertTextContent(nextContent, byteLimit);
      const record = {
        ...existing,
        content: nextContent,
        size,
        lineCount: countTextLines(nextContent),
        revision: currentRevision + 1,
        updatedAt: Date.now()
      };
      setIndexEntry(index, record);
      await chrome.storage.local.set({
        [storageKey(normalized)]: record,
        [VFS_INDEX_KEY]: index
      });
      return { ...toFileStat(record), startLine: firstLine, endLine: lastLine };
    });
  }

  async function unlink(path, { recursive = false, expectedRevision } = {}) {
    const normalized = normalizeVfsPath(path);
    if (normalized === "/") throw createVfsError("EPERM", "Cannot remove VFS root");
    return withMutationLock(async () => {
      const index = await loadVfsIndex();
      const exact = index.entries[normalized] || null;
      if (exact) {
        const currentRevision = Math.max(1, Number(exact.revision) || 1);
        if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
          throw createVfsError("ESTALE", `VFS revision changed from ${expectedRevision} to ${currentRevision}: ${normalized}`, {
            path: normalized,
            expectedRevision: Number(expectedRevision),
            currentRevision
          });
        }
        removeIndexEntry(index, normalized);
        await chrome.storage.local.remove(storageKey(normalized));
        await chrome.storage.local.set({ [VFS_INDEX_KEY]: index });
        return { path: normalized, removed: 1 };
      }
      if (expectedRevision != null) throw createVfsError("ENOENT", `VFS file not found: ${normalized}`);
      const records = getIndexEntries(index).filter(record => isWithin(record.path, normalized));
      if (!records.length) return { path: normalized, removed: 0 };
      if (!recursive) throw createVfsError("ENOTEMPTY", `VFS directory is not empty: ${normalized}`);
      records.forEach(record => removeIndexEntry(index, record.path));
      await chrome.storage.local.remove(records.map(record => storageKey(record.path)));
      await chrome.storage.local.set({ [VFS_INDEX_KEY]: index });
      return { path: normalized, removed: records.length };
    });
  }

  async function rename(oldPath, newPath, { overwrite = false } = {}) {
    const source = normalizeVfsPath(oldPath);
    const destination = normalizeVfsPath(newPath);
    if (source === "/" || destination === "/") throw createVfsError("EPERM", "Cannot rename VFS root");
    if (source === destination) return { oldPath: source, newPath: destination, moved: 0 };
    if (isWithin(destination, source) || isWithin(source, destination)) {
      throw createVfsError("EINVAL", "Cannot rename a VFS path into its ancestor or descendant");
    }
    return withMutationLock(async () => {
      const index = await loadVfsIndex();
      const entries = getIndexEntries(index);
      const sourceEntries = entries.filter(record => record.path === source || isWithin(record.path, source));
      if (!sourceEntries.length) throw createVfsError("ENOENT", `VFS path not found: ${source}`);
      const sourcePaths = new Set(sourceEntries.map(record => record.path));
      const destinationRecords = entries.filter(record =>
        !sourcePaths.has(record.path) && (record.path === destination || isWithin(record.path, destination))
      );
      const destinationAncestor = entries.find(record =>
        !sourcePaths.has(record.path) && isWithin(destination, record.path)
      );
      if (destinationAncestor) throw createVfsError("ENOTDIR", `VFS destination ancestor is a file: ${destinationAncestor.path}`);
      if (destinationRecords.length && !overwrite) {
        throw createVfsError("EEXIST", `VFS destination exists: ${destination}`);
      }

      const sourceKeys = sourceEntries.map(record => storageKey(record.path));
      const stored = await chrome.storage.local.get(sourceKeys);
      const sourceRecords = sourceEntries.map((entry, index) => {
        const record = stored[sourceKeys[index]];
        if (!record || record.type !== "file") throw createVfsError("ENOENT", `VFS file not found: ${entry.path}`);
        return record;
      });
      const moves = sourceRecords.map(record => ({
        record,
        destination: record.path === source ? destination : `${destination}${record.path.slice(source.length)}`
      }));
      const now = Date.now();
      const updates = {};
      [...sourceEntries, ...destinationRecords].forEach(record => removeIndexEntry(index, record.path));
      for (const move of moves) {
        const nextRecord = { ...move.record, path: move.destination, updatedAt: now };
        updates[storageKey(move.destination)] = nextRecord;
        setIndexEntry(index, nextRecord);
      }
      updates[VFS_INDEX_KEY] = index;
      await chrome.storage.local.set(updates);
      const destinationKeys = new Set(Object.keys(updates));
      const removals = [...sourceRecords, ...destinationRecords]
        .map(record => storageKey(record.path))
        .filter(key => !destinationKeys.has(key));
      if (removals.length) await chrome.storage.local.remove([...new Set(removals)]);
      return { oldPath: source, newPath: destination, moved: moves.length, replaced: destinationRecords.length };
    });
  }

  async function cleanupExpiredFiles({ now = Date.now() } = {}) {
    return withMutationLock(async () => {
      const index = await loadVfsIndex();
      const records = getIndexEntries(index);
      const expired = records.filter(record =>
        Number.isFinite(record.expireAt) && record.expireAt !== -1 && record.expireAt <= now
      );
      if (expired.length) {
        expired.forEach(record => removeIndexEntry(index, record.path));
        await chrome.storage.local.remove(expired.map(record => storageKey(record.path)));
        await chrome.storage.local.set({ [VFS_INDEX_KEY]: index });
      }
      return { scanned: records.length, removed: expired.length, paths: expired.map(record => record.path) };
    });
  }

  async function readJsonWithStat(path) {
    const result = await readFileWithStat(path);
    try {
      return { value: JSON.parse(result.content), stat: result.stat };
    } catch (error) {
      throw createVfsError("EBADJSON", `Invalid JSON in VFS file: ${normalizeVfsPath(path)}`, { cause: error });
    }
  }

  async function readJson(path) {
    return (await readJsonWithStat(path)).value;
  }

  async function writeJson(path, value, options) {
    return writeFile(path, JSON.stringify(value, null, 2), options);
  }

  function watch(path, listener) {
    const watchedPath = normalizeVfsPath(path);
    if (typeof listener !== "function") throw createVfsError("EINVAL", "VFS watch listener must be a function");
    const onChanged = (changes, areaName) => {
      if (areaName !== "local") return;
      for (const [key, change] of Object.entries(changes)) {
        const changedPath = pathFromStorageKey(key);
        if (!changedPath || (changedPath !== watchedPath && !isWithin(changedPath, watchedPath))) continue;
        listener({
          type: change.newValue ? (change.oldValue ? "change" : "create") : "delete",
          path: changedPath,
          oldStat: change.oldValue?.type === "file" ? toFileStat(change.oldValue) : null,
          stat: change.newValue?.type === "file" ? toFileStat(change.newValue) : null
        });
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }

  return {
    readFile,
    readFileWithStat,
    readFilesWithStats,
    writeFile,
    readLines,
    applyPatch,
    editRange,
    readdir,
    stat,
    exists,
    unlink,
    rename,
    cleanupExpiredFiles,
    readJson,
    readJsonWithStat,
    writeJson,
    watch,
    normalizePath: normalizeVfsPath,
    parentPath
  };
}

export const chromeStorageVfs = createChromeStorageVfs();
