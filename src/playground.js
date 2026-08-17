import { deflateStringToQueryParam, inflateStringFromQueryParam } from "./utils/playgroundCodec";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import "./playground.css";

const params = new URL(window.location.href).searchParams;

const iframe = document.createElement("iframe");
const editorPanel = document.createElement("div");
const toggleButton = document.createElement("button");
const shareButton = document.createElement("button");
const exportButton = document.createElement("button");
const controlBar = document.createElement("div");
const root = document.getElementById("root");
const PUBLIC_PLAYGROUND_BASE_URL = "https://sunwu51.github.io/HtmlPlaygroud/";

let expanded = parseExpanded(params.get("expanded"));
const embedded = params.get("embedded") === "1" && window.parent !== window;
const bridgeNonce = embedded ? (params.get("bridge") || "") : "";
let playgroundId = "";
let nextOperationId = 1;

const htmlInput = createCodeEditor("html-input", "HTML", inflateStringFromQueryParam(params.get("html") || ""), html());
const cssInput = createCodeEditor("css-input", "CSS", inflateStringFromQueryParam(params.get("css") || ""), css());
const jsInput = createCodeEditor("js-input", "JS", inflateStringFromQueryParam(params.get("js") || ""), javascript({ jsx: true }));

iframe.id = "preview";
iframe.setAttribute("sandbox", "allow-downloads allow-forms allow-modals allow-popups allow-presentation allow-scripts");

editorPanel.className = "editor-panel";
editorPanel.append(
  createEditorColumn(htmlInput, "HTML"),
  createEditorColumn(cssInput, "CSS"),
  createEditorColumn(jsInput, "JS")
);

toggleButton.id = "toggle-editors";
toggleButton.type = "button";
toggleButton.title = "展开/收起编辑区";

exportButton.id = "export-html";
exportButton.type = "button";
exportButton.textContent = "导出";
exportButton.title = "导出当前预览源码为 HTML 文件";

shareButton.id = "share-url";
shareButton.type = "button";
shareButton.textContent = "分享";
shareButton.title = "复制可公开访问的 GitHub Pages playground 链接";

controlBar.className = "control-bar";
controlBar.append(toggleButton, shareButton, exportButton);

root.append(editorPanel, controlBar, iframe);

function parseExpanded(value) {
  if (value == null || value === "") return false;
  return /^(1|true|yes|expanded)$/i.test(String(value));
}

function createCodeEditor(id, label, value, language) {
  const host = document.createElement("div");
  host.id = id;
  host.className = "editor-input";
  host.setAttribute("aria-label", label);
  const input = { id, host, view: null, suppressChanges: false };
  input.view = new EditorView({
    state: EditorState.create({
      doc: value,
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
        EditorView.updateListener.of(update => {
          if (update.docChanged && !input.suppressChanges) handleInput(input);
        }),
        language
      ]
    }),
    parent: host
  });
  return input;
}

function createEditorColumn(input, label) {
  const column = document.createElement("div");
  column.className = "editor-column";
  input.host.setAttribute("aria-label", label);
  column.append(input.host);
  return column;
}

function valueOf(input) {
  return input.view.state.doc.toString();
}

function setEditorValue(input, value) {
  const next = String(value);
  const current = valueOf(input);
  if (current === next) return;
  input.suppressChanges = true;
  input.view.dispatch({ changes: { from: 0, to: input.view.state.doc.length, insert: next } });
  input.suppressChanges = false;
}

function buildDocument() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${valueOf(cssInput)}
</style>
</head>
<body>
${valueOf(htmlInput)}
<script>
${valueOf(jsInput)}
</script>
</body>
</html>`;
}

function refreshPreview() {
  iframe.srcdoc = buildDocument();
}

function applyExpandedState() {
  document.body.classList.toggle("is-expanded", expanded);
  toggleButton.textContent = expanded ? "▲" : "▼";
  toggleButton.setAttribute("aria-expanded", String(expanded));
}

function downloadHtml() {
  let url = "";
  try {
    const blob = new Blob([buildDocument()], { type: "text/html;charset=utf-8" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "playground.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    flashExportButton("已导出");
  } catch (error) {
    console.error("Failed to export playground HTML:", error);
    flashExportButton("失败");
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function serializeQueryString({ forceCollapsed = false } = {}) {
  const next = new URLSearchParams();
  next.set("html", deflateStringToQueryParam(valueOf(htmlInput)));
  next.set("css", deflateStringToQueryParam(valueOf(cssInput)));
  next.set("js", deflateStringToQueryParam(valueOf(jsInput)));
  next.set("expanded", forceCollapsed ? "0" : (expanded ? "1" : "0"));
  return `?${next.toString()}`;
}

function buildShareUrl() {
  const publicUrl = new URL(PUBLIC_PLAYGROUND_BASE_URL);
  publicUrl.search = serializeQueryString({ forceCollapsed: true });
  return publicUrl.toString();
}

async function copyShareUrl() {
  const shareUrl = buildShareUrl();
  try {
    await navigator.clipboard.writeText(shareUrl);
    flashShareButton("已复制");
  } catch (error) {
    fallbackCopyText(shareUrl);
    flashShareButton("已复制");
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function flashShareButton(text) {
  const originalText = shareButton.textContent;
  shareButton.textContent = text;
  setTimeout(() => {
    shareButton.textContent = originalText;
  }, 1200);
}

function flashExportButton(text) {
  const originalText = exportButton.textContent;
  exportButton.textContent = text;
  setTimeout(() => {
    exportButton.textContent = originalText;
  }, 1200);
}

function handleInput(input) {
  refreshPreview();
  if (!embedded || !playgroundId) return;

  const fileByInputId = {
    "html-input": "index.html",
    "css-input": "style.css",
    "js-input": "script.js"
  };
  const file = fileByInputId[input.id];
  if (!file) return;
  window.parent.postMessage({
    type: "playground:write",
    bridgeNonce,
    playgroundId,
    operationId: nextOperationId++,
    file,
    content: valueOf(input)
  }, "*");
}

function handleHostMessage(event) {
  if (
    !embedded ||
    event.source !== window.parent ||
    event.data?.type !== "playground:load" ||
    event.data.bridgeNonce !== bridgeNonce
  ) return;

  const files = event.data.files || {};
  const preserveFiles = new Set(Array.isArray(event.data.preserveFiles) ? event.data.preserveFiles : []);
  const inputsByFile = {
    "index.html": htmlInput,
    "style.css": cssInput,
    "script.js": jsInput
  };
  playgroundId = String(event.data.playgroundId || "");
  Object.entries(inputsByFile).forEach(([file, input]) => {
    if (!preserveFiles.has(file)) {
      setEditorValue(input, String(files[file] || ""));
    }
  });
  refreshPreview();
}

toggleButton.addEventListener("click", () => {
  expanded = !expanded;
  applyExpandedState();
});

exportButton.addEventListener("click", downloadHtml);
shareButton.addEventListener("click", () => {
  void copyShareUrl();
});
window.addEventListener("message", handleHostMessage);

applyExpandedState();
refreshPreview();
if (embedded) {
  window.parent.postMessage({ type: "playground:ready", bridgeNonce }, "*");
}
