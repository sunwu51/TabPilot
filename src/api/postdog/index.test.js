import { afterEach, describe, expect, it, vi } from "vitest";
import { getChromeStorageSnapshot } from "../../../test/setup";
import {
  POSTDOG_REQUESTS_KEY,
  deletePostdogFolder,
  normalizeRequest,
  savePostdogFolder,
  savePostdogRequest
} from "./index";

describe("postdog storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes requests inside a deleted folder", async () => {
    const folder = await savePostdogFolder({ id: "folder-1", name: "API" });
    await savePostdogRequest({ id: "req-in-folder", name: "inside", folderId: folder.id, url: "https://api.example.com/a" });
    await savePostdogRequest({ id: "req-loose", name: "loose", url: "https://api.example.com/b" });

    const result = await deletePostdogFolder(folder.id);

    expect(result).toMatchObject({ removed: 1, removedRequests: 1 });
    const snapshot = getChromeStorageSnapshot();
    expect(snapshot[POSTDOG_REQUESTS_KEY]).toEqual([
      expect.objectContaining({ id: "req-loose", folderId: null })
    ]);
  });

  it("normalizes form and multipart fields", () => {
    const request = normalizeRequest({
      id: "req-fields",
      name: "fields",
      body: {
        type: "multipart",
        fields: [
          { key: "title", value: "hello" },
          { key: "upload", kind: "file", fileName: "a.txt", mimeType: "text/plain", dataBase64: "YQ==" }
        ]
      }
    });

    expect(request.body).toEqual({
      type: "multipart",
      text: "",
      fields: [
        expect.objectContaining({ key: "title", kind: "text", value: "hello" }),
        expect.objectContaining({ key: "upload", kind: "file", fileName: "a.txt", dataBase64: "YQ==" })
      ]
    });
  });
});
