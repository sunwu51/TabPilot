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

let expanded = parseExpanded(params.get("expanded"));

htmlInput.id = "html-input";
htmlInput.placeholder = "HTML";
htmlInput.spellcheck = false;
htmlInput.value = inflateStringFromQueryParam(params.get("html") || "");

cssInput.id = "css-input";
cssInput.placeholder = "CSS";
cssInput.spellcheck = false;
cssInput.value = inflateStringFromQueryParam(params.get("css") || "");

jsInput.id = "js-input";
jsInput.placeholder = "JS";
jsInput.spellcheck = false;
jsInput.value = inflateStringFromQueryParam(params.get("js") || "");

iframe.id = "preview";
iframe.setAttribute("sandbox", "allow-downloads allow-forms allow-modals allow-popups allow-presentation allow-scripts");

editorPanel.className = "editor-panel";
editorPanel.append(htmlInput, cssInput, jsInput);

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

function handleInput() {
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

applyExpandedState();
refreshPreview();
