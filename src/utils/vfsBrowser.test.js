import { describe, expect, it } from "vitest";
import { chromeStorageVfs as vfs } from "./chromeStorageVfs";
import { saveStashRecordToVfs } from "./stashVfs";
import { listVfsEntries } from "./vfsBrowser";
import { _execVfsList } from "../api/llm/tools/builtins/vfs";

describe("VFS browsing", () => {
  it("lists root directories and annotates projects and nested source files", async () => {
    await vfs.writeJson("/playgrounds/pg_test/.project.json", { id: "pg_test" });
    await vfs.writeFile("/playgrounds/pg_test/index.html", "<h1>Hello</h1>");
    await vfs.writeJson("/webide/ide_test/.project.json", { id: "ide_test" });
    await vfs.writeFile("/webide/ide_test/src/main.jsx", "export default 1;");
    expect((await listVfsEntries()).entries.map(entry => entry.path)).toEqual(["/playgrounds", "/webide"]);
    const project = (await listVfsEntries({ path: "/playgrounds" })).entries[0];
    expect(project).toMatchObject({ type: "directory", kind: "playground", projectId: "pg_test", url: "chrome-extension://test-extension/playground-host.html?id=pg_test" });
    const result = await _execVfsList({ recursive: true });
    expect(result.success).toBe(true);
    expect(result.entries.find(entry => entry.path.endsWith("main.jsx"))).toMatchObject({ kind: "webide", projectRoot: "/webide/ide_test", url: "chrome-extension://test-extension/webide-host.html?id=ide_test" });
  });

  it("identifies stash titles and does not mislabel arbitrary JSON or missing project metadata", async () => {
    await saveStashRecordToVfs({ title: "偏好 / &", info: "hello", expireAt: -1 });
    await vfs.writeFile("/stashes/invalid.json", "{");
    await vfs.writeFile("/playgrounds/fake/index.html", "hello");
    const { entries } = await listVfsEntries({ recursive: true });
    const stash = entries.find(entry => entry.kind === "stash");
    expect(stash.title).toBe("偏好 / &");
    expect(new URL(stash.url).searchParams.get("title")).toBe(stash.title);
    expect(entries.find(entry => entry.name === "invalid.json").kind).toBe("text");
    expect(entries.find(entry => entry.name === "index.html").kind).toBe("text");
  });

  it("reports missing directories and file paths", async () => {
    await expect(listVfsEntries({ path: "/missing" })).rejects.toMatchObject({ code: "ENOENT" });
    await vfs.writeFile("/note.txt", "hi");
    await expect(listVfsEntries({ path: "/note.txt" })).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
