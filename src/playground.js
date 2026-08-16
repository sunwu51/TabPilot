import { deflateStringToQueryParam, inflateStringFromQueryParam } from "./utils/playgroundCodec";
import "./playground.css";

const params = new URL(window.location.href).searchParams;

const htmlInput = document.createElement("textarea");
const cssInput = document.createElement("textarea");
const jsInput = document.createElement("textarea");
const iframe = document.createElement("iframe");
const editorPanel = document.createElement("div");
const toggleButton = document.createElement("button");
const shareButton = document.createElement("button");
const exportButton = document.createElement("button");
const controlBar = document.createElement("div");
const root = document.getElementById("root");
const PUBLIC_PLAYGROUND_BASE_URL = "https://sunwu51.github.io/HtmlPlaygroud/";
const editorGutters = new Map();

let expanded = parseExpanded(params.get("expanded"));
const embedded = params.get("embedded") === "1" && window.parent !== window;
const bridgeNonce = embedded ? (params.get("bridge") || "") : "";
let playgroundId = "";
let nextOperationId = 1;

htmlInput.id = "html-input";
htmlInput.className = "editor-input";
htmlInput.placeholder = "HTML";
htmlInput.spellcheck = false;
htmlInput.wrap = "off";
htmlInput.value = inflateStringFromQueryParam(params.get("html") || "");

cssInput.id = "css-input";
cssInput.className = "editor-input";
cssInput.placeholder = "CSS";
cssInput.spellcheck = false;
cssInput.wrap = "off";
cssInput.value = inflateStringFromQueryParam(params.get("css") || "");

jsInput.id = "js-input";
jsInput.className = "editor-input";
jsInput.placeholder = "JS";
jsInput.spellcheck = false;
jsInput.wrap = "off";
jsInput.value = inflateStringFromQueryParam(params.get("js") || "");

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

function createEditorColumn(input, label) {
  const column = document.createElement("div");
  const gutter = document.createElement("div");
  column.className = "editor-column";
  gutter.className = "editor-gutter";
  gutter.setAttribute("aria-hidden", "true");
  input.setAttribute("aria-label", label);
  editorGutters.set(input, gutter);
  column.append(gutter, input);
  updateEditorGutter(input);
  input.addEventListener("scroll", () => {
    gutter.scrollTop = input.scrollTop;
  });
  return column;
}

function updateEditorGutter(input) {
  const gutter = editorGutters.get(input);
  if (!gutter) return;
  const lineCount = input.value === "" ? 1 : input.value.split("\n").length;
  gutter.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  gutter.scrollTop = input.scrollTop;
}

function buildDocument() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${cssInput.value}
</style>
</head>
<body>
${htmlInput.value}
<script>
${jsInput.value}
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
  next.set("html", deflateStringToQueryParam(htmlInput.value));
  next.set("css", deflateStringToQueryParam(cssInput.value));
  next.set("js", deflateStringToQueryParam(jsInput.value));
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

function handleInput(event) {
  updateEditorGutter(event.target);
  refreshPreview();
  if (!embedded || !playgroundId) return;

  const fileByInputId = {
    "html-input": "index.html",
    "css-input": "style.css",
    "js-input": "script.js"
  };
  const file = fileByInputId[event?.target?.id];
  if (!file) return;
  window.parent.postMessage({
    type: "playground:write",
    bridgeNonce,
    playgroundId,
    operationId: nextOperationId++,
    file,
    content: event.target.value
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
      input.value = String(files[file] || "");
      updateEditorGutter(input);
    }
  });
  refreshPreview();
}

htmlInput.addEventListener("input", handleInput);
cssInput.addEventListener("input", handleInput);
jsInput.addEventListener("input", handleInput);

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
