import { describe, expect, it } from "vitest";
import { chromeStorageVfs } from "./chromeStorageVfs";
import {
  createWebIdeProject,
  getWebIdeFilePath,
  getWebIdeProject,
  requireWebIdeProject
} from "./webIdeProjects";

describe("WebIDE projects", () => {
  it("creates a React project with pinned dependencies and expiring VFS files", async () => {
    const expireAt = Date.now() + 60_000;
    const project = await createWebIdeProject({ template: "react", name: "Dashboard", expireAt });

    expect(project).toMatchObject({
      template: "react",
      name: "Dashboard",
      entry: "src/main.jsx",
      expireAt,
      files: {
        "index.html": expect.stringContaining("Dashboard"),
        "src/main.jsx": expect.stringContaining("react-dom/client"),
        "src/App.jsx": expect.stringContaining("function App")
      }
    });
    expect(JSON.parse(project.files["package.json"]).dependencies).toEqual({
      react: "18.3.1",
      "react-dom": "18.3.1"
    });
    await expect(chromeStorageVfs.stat(getWebIdeFilePath(project.id, "src/main.jsx")))
      .resolves.toMatchObject({ expireAt });
  });

  it("creates and reloads a Vanilla JavaScript project", async () => {
    const project = await createWebIdeProject({ template: "vanilla" });
    await chromeStorageVfs.writeFile(getWebIdeFilePath(project.id, "src/helper.js"), "export const value = 1;", {
      expireAt: project.expireAt
    });

    await expect(getWebIdeProject(project.id)).resolves.toMatchObject({
      template: "vanilla",
      entry: "src/main.js",
      files: { "src/helper.js": "export const value = 1;" }
    });
    await expect(requireWebIdeProject("missing")).rejects.toThrow("WebIDE project not found");
  });
});
