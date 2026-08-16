import { chromeStorageVfs } from "../../../../utils/chromeStorageVfs";

export async function _execVfsReadFile({ path, startLine, endLine } = {}) {
  const result = await chromeStorageVfs.readLines(path, { startLine, endLine });
  return { success: true, ...result };
}

export async function _execVfsWriteFile({ path, content, expectedRevision, expireAt } = {}) {
  const result = await chromeStorageVfs.writeFile(path, content, { expectedRevision, expireAt });
  return { success: true, ...result };
}

export async function _execVfsEditFile({ path, startLine, endLine, originalContent, newContent, expectedRevision } = {}) {
  const result = await chromeStorageVfs.editRange(path, {
    startLine,
    endLine,
    originalContent,
    newContent,
    expectedRevision
  });
  return { success: true, ...result };
}
