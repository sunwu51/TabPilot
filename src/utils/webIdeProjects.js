import { chromeStorageVfs } from "./chromeStorageVfs";
import { DEFAULT_PLAYGROUND_TTL_MS } from "./playgroundProjects";

export const WEB_IDE_TEMPLATES = Object.freeze(["vanilla", "react"]);

function normalizeProjectId(projectId) {
  const value = String(projectId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid webIdeProjectId");
  return value;
}

function normalizeTemplate(template) {
  const value = String(template || "vanilla").trim().toLowerCase();
  if (!WEB_IDE_TEMPLATES.includes(value)) throw new Error(`Unsupported WebIDE template: ${value}`);
  return value;
}

function createProjectId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `ide_${uuid.replace(/-/g, "")}` : `ide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeRelativePath(path) {
  const raw = String(path || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`WebIDE path escapes project root: ${path}`);
    parts.push(part);
  }
  const value = parts.join("/");
  if (!value || value === ".project.json") throw new Error(`Invalid WebIDE file path: ${path}`);
  return value;
}

export function getWebIdeProjectPath(projectId) {
  return `/webide/${normalizeProjectId(projectId)}`;
}

export function getWebIdeFilePath(projectId, path) {
  return `${getWebIdeProjectPath(projectId)}/${normalizeRelativePath(path)}`;
}

function getMetadataPath(projectId) {
  return `${getWebIdeProjectPath(projectId)}/.project.json`;
}

function createTemplateFiles(template, name) {
  const title = String(name || (template === "react" ? "React WebIDE" : "Vanilla WebIDE"));
  if (template === "react") {
    return {
      "package.json": JSON.stringify({
        name: "webide-react-project",
        private: true,
        dependencies: { react: "18.3.1", "react-dom": "18.3.1" }
      }, null, 2),
      "index.html": `<!doctype html>\n<html>\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>\n</head>\n<body>\n  <div id="root"></div>\n</body>\n</html>`,
      "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./styles.css";\n\ncreateRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);`,
      "src/App.jsx": `export default function App() {\n  return (\n    <main className="app">\n      <h1>${title}</h1>\n      <p>Edit the project files to begin.</p>\n    </main>\n  );\n}`,
      "src/styles.css": `:root {\n  font-family: Inter, system-ui, sans-serif;\n  color: #172033;\n  background: #f5f7fb;\n}\n\nbody {\n  margin: 0;\n}\n\n.app {\n  max-width: 720px;\n  margin: 64px auto;\n  padding: 32px;\n  background: white;\n  border: 1px solid #dce2ec;\n  border-radius: 8px;\n}`
    };
  }
  return {
    "package.json": JSON.stringify({ name: "webide-vanilla-project", private: true, dependencies: {} }, null, 2),
    "index.html": `<!doctype html>\n<html>\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>\n</head>\n<body>\n  <main id="app"></main>\n</body>\n</html>`,
    "src/main.js": `import "./styles.css";\n\nconst app = document.getElementById("app");\napp.innerHTML = \`\n  <section class="app">\n    <h1>${title}</h1>\n    <p>Edit the project files to begin.</p>\n  </section>\n\`;`,
    "src/styles.css": `:root {\n  font-family: Inter, system-ui, sans-serif;\n  color: #172033;\n  background: #f5f7fb;\n}\n\nbody {\n  margin: 0;\n}\n\n.app {\n  max-width: 720px;\n  margin: 64px auto;\n  padding: 32px;\n  background: white;\n  border: 1px solid #dce2ec;\n  border-radius: 8px;\n}`
  };
}

export async function createWebIdeProject({ template = "vanilla", name, expireAt } = {}) {
  const normalizedTemplate = normalizeTemplate(template);
  let projectId = createProjectId();
  while (await chromeStorageVfs.exists(getMetadataPath(projectId))) projectId = createProjectId();
  const now = Date.now();
  const normalizedExpireAt = expireAt === -1 || (Number.isFinite(Number(expireAt)) && Number(expireAt) > now)
    ? Number(expireAt)
    : now + DEFAULT_PLAYGROUND_TTL_MS;
  const files = createTemplateFiles(normalizedTemplate, name);
  const metadata = {
    id: projectId,
    name: String(name || (normalizedTemplate === "react" ? "React WebIDE" : "Vanilla WebIDE")),
    template: normalizedTemplate,
    entry: normalizedTemplate === "react" ? "src/main.jsx" : "src/main.js",
    createdAt: now,
    updatedAt: now,
    expireAt: normalizedExpireAt
  };
  const written = [];
  try {
    for (const [path, content] of Object.entries(files)) {
      const stat = await chromeStorageVfs.writeFile(getWebIdeFilePath(projectId, path), content, {
        overwrite: false,
        expireAt: normalizedExpireAt
      });
      written.push(stat.path);
    }
    const stat = await chromeStorageVfs.writeJson(getMetadataPath(projectId), metadata, {
      overwrite: false,
      expireAt: normalizedExpireAt
    });
    written.push(stat.path);
  } catch (error) {
    await Promise.all(written.map(path => chromeStorageVfs.unlink(path).catch(() => undefined)));
    throw error;
  }
  return getWebIdeProject(projectId);
}

export async function getWebIdeProject(projectId) {
  const id = normalizeProjectId(projectId);
  let metadata;
  try {
    metadata = await chromeStorageVfs.readJson(getMetadataPath(id));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const entries = await chromeStorageVfs.readdir(getWebIdeProjectPath(id), { recursive: true });
  const paths = entries.filter(entry => entry.type === "file" && entry.name !== ".project.json").map(entry => entry.path);
  const records = paths.length ? await chromeStorageVfs.readFilesWithStats(paths) : {};
  const files = {};
  const fileStats = {};
  for (const path of paths) {
    const relativePath = path.slice(getWebIdeProjectPath(id).length + 1);
    files[relativePath] = records[path].content;
    fileStats[relativePath] = records[path].stat;
  }
  return { ...metadata, id, rootPath: getWebIdeProjectPath(id), files, fileStats };
}

export async function requireWebIdeProject(projectId) {
  const project = await getWebIdeProject(projectId);
  if (!project) throw new Error(`WebIDE project not found: ${projectId}`);
  return project;
}
