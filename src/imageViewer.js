/* global chrome */
import "./imageViewer.css";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.2;

const state = {
  root: null,
  sessionId: "",
  refs: [],
  index: -1,
  zoom: 1,
  offset: { x: 0, y: 0 },
  drag: null,
  image: null,
  stage: null,
  zoomLabel: null,
  title: null,
  prevButton: null,
  nextButton: null
};

async function main() {
  state.root = document.getElementById("root");
  const params = new URL(window.location.href).searchParams;
  state.sessionId = String(params.get("sessionId") || "").trim();
  const ref = String(params.get("ref") || "").trim();
  if (!state.root || !state.sessionId || !ref) {
    renderStatus("图片不存在");
    return;
  }

  const imageStore = await loadImageStore(state.sessionId);
  state.refs = Object.entries(imageStore)
    .filter(([candidateRef, source]) => /^img_\d+$/.test(candidateRef) && isBase64DataUrl(source))
    .sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4)))
    .map(([candidateRef, source]) => ({ ref: candidateRef, src: source }));

  state.index = state.refs.findIndex(item => item.ref === ref);
  if (state.index < 0) {
    renderStatus("图片已过期或不存在");
    return;
  }

  renderViewer();
  showImageAt(state.index, { resetView: true, replaceHistory: true });
}

async function loadImageStore(sessionId) {
  const imageStoreKey = `session_${sessionId}_images`;
  const result = await chrome.storage.local.get({ [imageStoreKey]: {} });
  return result[imageStoreKey] && typeof result[imageStoreKey] === "object"
    ? result[imageStoreKey]
    : {};
}

function renderViewer() {
  state.root.textContent = "";
  const shell = document.createElement("div");
  shell.className = "image-viewer-shell";
  shell.innerHTML = `
    <header class="image-viewer-toolbar">
      <div class="image-viewer-title"></div>
      <div class="image-viewer-controls">
        <button type="button" class="image-viewer-btn" data-action="zoom-out" title="缩小" aria-label="缩小">-</button>
        <button type="button" class="image-viewer-btn" data-action="zoom-in" title="放大" aria-label="放大">+</button>
        <button type="button" class="image-viewer-btn" data-action="fit" title="适应窗口" aria-label="适应窗口">适应</button>
        <button type="button" class="image-viewer-btn" data-action="actual" title="原图大小" aria-label="原图大小">100%</button>
      </div>
    </header>
    <main class="image-viewer-stage" aria-label="图片预览区域">
      <button type="button" class="image-viewer-nav image-viewer-nav-prev" data-action="prev" aria-label="上一张">‹</button>
      <img class="image-viewer-img" alt="图片预览" draggable="false" />
      <button type="button" class="image-viewer-nav image-viewer-nav-next" data-action="next" aria-label="下一张">›</button>
    </main>
    <footer class="image-viewer-meta">
      <span class="image-viewer-zoom">100%</span>
      <span>滚轮缩放，按住拖拽查看细节，方向键切换图片</span>
    </footer>
  `;
  state.root.appendChild(shell);

  state.title = shell.querySelector(".image-viewer-title");
  state.stage = shell.querySelector(".image-viewer-stage");
  state.image = shell.querySelector(".image-viewer-img");
  state.zoomLabel = shell.querySelector(".image-viewer-zoom");
  state.prevButton = shell.querySelector('[data-action="prev"]');
  state.nextButton = shell.querySelector('[data-action="next"]');
  state.image.addEventListener("load", fitToWindow);

  shell.addEventListener("click", handleClick);
  state.stage.addEventListener("wheel", handleWheel, { passive: false });
  state.stage.addEventListener("pointerdown", handlePointerDown);
  state.stage.addEventListener("pointermove", handlePointerMove);
  state.stage.addEventListener("pointerup", finishDrag);
  state.stage.addEventListener("pointercancel", finishDrag);
  window.addEventListener("keydown", handleKeyDown);
}

function handleClick(event) {
  const action = event.target?.closest?.("[data-action]")?.dataset?.action;
  if (!action) return;
  if (action === "zoom-out") zoomBy(-ZOOM_STEP);
  else if (action === "zoom-in") zoomBy(ZOOM_STEP);
  else if (action === "fit") fitToWindow();
  else if (action === "actual") setZoom(1);
  else if (action === "prev") navigate(-1);
  else if (action === "next") navigate(1);
}

function handleKeyDown(event) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigate(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    navigate(1);
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomBy(ZOOM_STEP);
  } else if (event.key === "-") {
    event.preventDefault();
    zoomBy(-ZOOM_STEP);
  } else if (event.key === "0") {
    event.preventDefault();
    setZoom(1);
  }
}

function handleWheel(event) {
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
}

function handlePointerDown(event) {
  if (event.button !== 0 || event.target?.closest?.(".image-viewer-nav")) return;
  event.preventDefault();
  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.offset.x,
    originY: state.offset.y
  };
  state.stage.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  state.offset = {
    x: drag.originX + event.clientX - drag.startX,
    y: drag.originY + event.clientY - drag.startY
  };
  applyTransform();
}

function finishDrag(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.drag = null;
  if (state.stage.hasPointerCapture?.(event.pointerId)) {
    state.stage.releasePointerCapture?.(event.pointerId);
  }
}

function navigate(delta) {
  const nextIndex = state.index + delta;
  if (nextIndex < 0 || nextIndex >= state.refs.length) return;
  showImageAt(nextIndex, { resetView: true });
}

function showImageAt(index, { resetView = false, replaceHistory = false } = {}) {
  const item = state.refs[index];
  if (!item) return;
  state.index = index;
  if (resetView) {
    state.zoom = 1;
    state.offset = { x: 0, y: 0 };
  }
  state.image.src = item.src;
  state.image.alt = item.ref;
  document.title = item.ref;
  state.title.textContent = `${item.ref} · ${index + 1} / ${state.refs.length}`;
  state.prevButton.disabled = index <= 0;
  state.nextButton.disabled = index >= state.refs.length - 1;
  applyTransform();
  updateUrl(item.ref, replaceHistory);
}

function updateUrl(ref, replaceHistory = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("ref", ref);
  url.searchParams.set("title", ref);
  if (replaceHistory) {
    window.history.replaceState(null, "", url.href);
  } else {
    window.history.pushState(null, "", url.href);
  }
}

function zoomBy(delta) {
  setZoom(state.zoom + delta);
}

function setZoom(value) {
  state.zoom = clampZoom(value);
  applyTransform();
}

function fitToWindow() {
  const rect = state.stage.getBoundingClientRect();
  const naturalWidth = state.image.naturalWidth || state.image.width;
  const naturalHeight = state.image.naturalHeight || state.image.height;
  if (!naturalWidth || !naturalHeight || !rect.width || !rect.height) {
    setZoom(1);
    return;
  }
  state.offset = { x: 0, y: 0 };
  setZoom(Math.min(1, (rect.width - 48) / naturalWidth, (rect.height - 48) / naturalHeight));
}

function applyTransform() {
  state.image.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.zoom})`;
  state.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(numeric * 100) / 100));
}

function isBase64DataUrl(value) {
  return typeof value === "string" && /^data:image\/[^;]+;base64,/.test(value);
}

function renderStatus(text) {
  if (!state.root) return;
  state.root.textContent = "";
  const status = document.createElement("div");
  status.className = "image-viewer-status";
  status.textContent = text;
  state.root.appendChild(status);
}

main().catch(error => {
  console.error("Failed to load image viewer:", error);
  renderStatus("图片加载失败");
});
