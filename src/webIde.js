import { buildWebIdeModules, normalizeWebIdePath } from "./utils/webIdeRuntime";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import "./webIde.css";

const params = new URL(location.href).searchParams;
const embedded = params.get("embedded") === "1" && window.parent !== window;
const nonce = embedded ? params.get("bridge") || "" : "";
const root = document.getElementById("webide-root");
let project = null;
let activePath = "";
let openPaths = [];
let files = {};
let dirtyPaths = new Set();
const pendingOperations = new Map();
let operationId = 1;
let buildTimer = null;
let saveTimer = null;
const BUILD_IDLE_DELAY_MS = 900;

const shell = element("div", "webide-shell");
const toolbar = element("header", "webide-toolbar");
const title = element("div", "webide-title", "WebIDE");
const templateLabel = element("span", "webide-template", "");
const buildButton = element("button", "webide-command", "Build");
buildButton.type = "button";
const workspace = element("div", "webide-workspace");
const sidebar = element("aside", "webide-sidebar");
const sidebarHeader = element("div", "webide-sidebar-header");
const filesLabel = element("span", "", "Files");
const addFileButton = element("button", "webide-icon-button", "+");
addFileButton.type = "button";
addFileButton.title = "Create file";
addFileButton.setAttribute("aria-label", "Create file");
const fileList = element("div", "webide-file-list");
const editorPane = element("section", "webide-editor-pane");
const tabs = element("div", "webide-tabs");
const editor = element("div", "webide-editor");
editor.setAttribute("aria-label", "Project file editor");
const languageCompartment = new Compartment();
const editableCompartment = new Compartment();
let editorView = null;
let suppressEditorChanges = false;
let compositionActive = false;
const errors = element("div", "webide-errors");
errors.hidden = true;
const previewPane = element("section", "webide-preview-pane");
const previewHeader = element("div", "webide-preview-header", "Preview");
const preview = document.createElement("iframe");
preview.className = "webide-preview";
preview.title = "WebIDE preview";
preview.setAttribute("sandbox", "allow-downloads allow-forms allow-modals allow-popups allow-presentation allow-scripts");
const statusbar = element("footer", "webide-statusbar");
const statusText = element("span", "", "Waiting for project");
const fileStatus = element("span", "", "");

toolbar.append(title, templateLabel, buildButton);
sidebarHeader.append(filesLabel, addFileButton);
sidebar.append(sidebarHeader, fileList);
editorPane.append(tabs, editor, errors);
previewPane.append(previewHeader, preview);
workspace.append(sidebar, editorPane, previewPane);
statusbar.append(statusText, fileStatus);
shell.append(toolbar, workspace, statusbar);
root.append(shell);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function normalizePath(path) {
  return normalizeWebIdePath(path);
}

function languageForPath(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jsx") return javascript({ jsx: true });
  if (extension === "tsx") return javascript({ jsx: true, typescript: true });
  if (extension === "js" || extension === "mjs" || extension === "cjs") return javascript({ jsx: true });
  if (extension === "ts") return javascript({ typescript: true });
  if (extension === "css") return css();
  if (extension === "json") return json();
  if (extension === "html" || extension === "htm") return html();
  return [];
}

function createEditor() {
  editorView = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        oneDark,
        lineNumbers(),
        highlightSpecialChars(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorState.tabSize.of(2),
        languageCompartment.of([]),
        editableCompartment.of(EditorView.editable.of(false)),
        EditorView.updateListener.of(update => {
          if (!update.docChanged || suppressEditorChanges || !activePath) return;
          files[activePath] = update.state.doc.toString();
          dirtyPaths.add(activePath);
          if (compositionActive || update.view.composing) return;
          scheduleSave();
          scheduleBuild();
        })
      ]
    }),
    parent: editor
  });
  editor.addEventListener("compositionstart", () => {
    compositionActive = true;
  });
  editor.addEventListener("compositionend", () => {
    compositionActive = false;
    if (!activePath) return;
    scheduleSave();
    scheduleBuild();
  });
}

function parsePackageJson() {
  try {
    const value = JSON.parse(files["package.json"] || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    throw new Error(`Invalid package.json: ${error.message}`);
  }
}

function formatBuildError(error) {
  if (Array.isArray(error?.errors) && error.errors.length) {
    return error.errors.map(item => {
      const location = item.location ? `${item.location.file || ""}:${item.location.line}:${item.location.column}` : "build";
      return `${location} ${item.text}`;
    }).join("\n");
  }
  return error?.message || String(error);
}

function buildPreviewHtml(html, importMap, entry) {
  let documentSource = String(html || "<!doctype html><html><body><div id=\"app\"></div></body></html>");
  const safeImportMap = JSON.stringify(importMap).replace(/<\/script/gi, "<" + "\\/script");
  const scriptTag = `<script type="importmap">${safeImportMap}</script><script type="module">import ${JSON.stringify(entry)};</script>`;
  return documentSource.includes("</body>") ? documentSource.replace("</body>", `${scriptTag}</body>`) : `${documentSource}${scriptTag}`;
}

async function buildProject() {
  if (!project) return;
  statusText.textContent = "Building...";
  errors.hidden = true;
  try {
    const packageJson = parsePackageJson();
    const result = await buildWebIdeModules({
      files,
      entry: project.entry,
      dependencies: packageJson.dependencies || {}
    });
    preview.srcdoc = buildPreviewHtml(files["index.html"], result.importMap, result.entry);
    statusText.textContent = `Built ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    const message = formatBuildError(error);
    errors.textContent = message;
    errors.hidden = false;
    statusText.textContent = "Build failed";
  }
}

function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => void buildProject(), BUILD_IDLE_DELAY_MS);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!activePath || !dirtyPaths.has(activePath)) return;
    const currentOperationId = operationId++;
    pendingOperations.set(activePath, currentOperationId);
    window.parent.postMessage({
      type: "webide:write",
      nonce,
      operationId: currentOperationId,
      path: activePath,
      content: files[activePath]
    }, "*");
  }, 250);
}

function setActiveFile(path) {
  if (!Object.prototype.hasOwnProperty.call(files, path)) return;
  if (!editorView) createEditor();
  const shouldUpdateEditor = activePath !== path || editorView.state.doc.toString() !== files[path];
  activePath = path;
  if (!openPaths.includes(path)) openPaths.push(path);
  if (shouldUpdateEditor) {
    suppressEditorChanges = true;
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: files[path] },
      effects: [
        languageCompartment.reconfigure(languageForPath(path)),
        editableCompartment.reconfigure(EditorView.editable.of(true))
      ]
    });
    suppressEditorChanges = false;
  }
  fileStatus.textContent = path;
  renderFiles();
  renderTabs();
}

function renderFiles() {
  fileList.replaceChildren(...Object.keys(files).sort().map(path => {
    const button = element("button", `webide-file${path === activePath ? " is-active" : ""}`, path);
    button.type = "button";
    button.title = path;
    button.addEventListener("click", () => setActiveFile(path));
    return button;
  }));
}

function renderTabs() {
  tabs.replaceChildren(...openPaths.filter(path => Object.prototype.hasOwnProperty.call(files, path)).map(path => {
    const button = element("button", `webide-tab${path === activePath ? " is-active" : ""}`, path.split("/").pop());
    button.type = "button";
    button.title = path;
    button.addEventListener("click", () => setActiveFile(path));
    return button;
  }));
}

function loadProject(nextProject) {
  project = nextProject;
  const incomingFiles = nextProject.files || {};
  for (const [path, content] of Object.entries(incomingFiles)) {
    if (!dirtyPaths.has(path)) files[path] = String(content);
  }
  for (const path of Object.keys(files)) {
    if (!Object.prototype.hasOwnProperty.call(incomingFiles, path) && !dirtyPaths.has(path)) delete files[path];
  }
  title.textContent = nextProject.name || nextProject.id;
  templateLabel.textContent = nextProject.template;
  const preferredPath = activePath && files[activePath] != null ? activePath : nextProject.entry;
  setActiveFile(files[preferredPath] != null ? preferredPath : Object.keys(files).sort()[0]);
  scheduleBuild();
}

buildButton.addEventListener("click", () => void buildProject());
addFileButton.addEventListener("click", () => {
  const path = normalizePath(prompt("New project-relative file path", "src/component.js") || "");
  if (!path || path === ".project.json" || files[path] != null) return;
  files[path] = "";
  dirtyPaths.add(path);
  setActiveFile(path);
  scheduleSave();
});

window.addEventListener("message", event => {
  if (!embedded || event.source !== window.parent || event.data?.nonce !== nonce) return;
  if (event.data.type === "webide:load") loadProject(event.data.project);
  if (event.data.type === "webide:saved") {
    const path = String(event.data.path || "");
    if (pendingOperations.get(path) === Number(event.data.operationId)) {
      pendingOperations.delete(path);
      dirtyPaths.delete(path);
      statusText.textContent = `Saved ${new Date().toLocaleTimeString()}`;
    }
  }
});

if (embedded) window.parent.postMessage({ type: "webide:ready", nonce }, "*");
else statusText.textContent = "Open through webide-host.html with a project id";
