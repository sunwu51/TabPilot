/* global chrome */
import "./imageViewer.css";

async function main() {
  const root = document.getElementById("root");
  const params = new URL(window.location.href).searchParams;
  const sessionId = String(params.get("sessionId") || "").trim();
  const ref = String(params.get("ref") || "").trim();
  if (!root || !sessionId || !ref) {
    renderStatus(root, "图片不存在");
    return;
  }

  const imageStoreKey = `session_${sessionId}_images`;
  const result = await chrome.storage.local.get({ [imageStoreKey]: {} });
  const imageStore = result[imageStoreKey] && typeof result[imageStoreKey] === "object"
    ? result[imageStoreKey]
    : {};
  const src = imageStore[ref];
  if (!src) {
    renderStatus(root, "图片已过期或不存在");
    return;
  }

  const title = String(params.get("title") || ref || "图片预览");
  document.title = title;
  root.textContent = "";
  const image = document.createElement("img");
  image.className = "image-viewer-img";
  image.src = src;
  image.alt = title;
  root.appendChild(image);
}

function renderStatus(root, text) {
  if (!root) return;
  root.textContent = "";
  const status = document.createElement("div");
  status.className = "image-viewer-status";
  status.textContent = text;
  root.appendChild(status);
}

main().catch(error => {
  console.error("Failed to load image viewer:", error);
  renderStatus(document.getElementById("root"), "图片加载失败");
});
