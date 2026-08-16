/* global chrome */
import {
  getPlaygroundProject,
  getPlaygroundProjectPath,
  normalizePlaygroundFileName,
  replacePlaygroundFile
} from "./utils/playgroundProjects";
import { chromeStorageVfs } from "./utils/chromeStorageVfs";
import "./playgroundHost.css";

const params = new URL(window.location.href).searchParams;
const playgroundId = params.get("id") || "";
const expanded = params.get("expanded") || "0";
const bridgeNonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const frame = document.getElementById("playground-frame");
const errorPanel = document.getElementById("playground-error");
const pendingWrites = new Map();
let project = null;
let frameReady = false;
let saveQueue = Promise.resolve();
let reloadQueue = Promise.resolve();

function showError(message) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

function postProject() {
  if (!frameReady || !project || !frame.contentWindow) return;
  frame.contentWindow.postMessage({
    type: "playground:load",
    bridgeNonce,
    playgroundId,
    files: project.files,
    preserveFiles: [...pendingWrites.keys()],
    revision: project.revision
  }, "*");
}

async function initialize() {
  try {
    project = await getPlaygroundProject(playgroundId);
    if (!project) {
      showError(`Playground project not found: ${playgroundId || "(missing id)"}`);
      return;
    }
    const sandboxUrl = new URL(chrome.runtime.getURL("playground.html"));
    sandboxUrl.searchParams.set("expanded", expanded);
    sandboxUrl.searchParams.set("embedded", "1");
    sandboxUrl.searchParams.set("bridge", bridgeNonce);
    frame.src = sandboxUrl.toString();
    chromeStorageVfs.watch(getPlaygroundProjectPath(playgroundId), () => {
      reloadQueue = reloadQueue.then(async () => {
        project = await getPlaygroundProject(playgroundId);
        postProject();
      }).catch(error => showError(error?.message || String(error)));
    });
  } catch (error) {
    showError(error?.message || String(error));
  }
}

window.addEventListener("message", event => {
  if (event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
  if (event.data.bridgeNonce !== bridgeNonce) return;
  if (event.data.type === "playground:ready") {
    frameReady = true;
    postProject();
    return;
  }
  if (
    event.data.type !== "playground:write" ||
    event.data.playgroundId !== playgroundId ||
    typeof event.data.content !== "string" ||
    !Number.isSafeInteger(event.data.operationId)
  ) return;

  const file = normalizePlaygroundFileName(event.data.file);
  const content = event.data.content;
  const operationId = event.data.operationId;
  pendingWrites.set(file, operationId);
  saveQueue = saveQueue.then(async () => {
    await replacePlaygroundFile(playgroundId, file, content);
    if (pendingWrites.get(file) === operationId) pendingWrites.delete(file);
    project = await getPlaygroundProject(playgroundId);
    postProject();
  }).catch(error => {
    if (pendingWrites.get(file) === operationId) pendingWrites.delete(file);
    showError(error?.message || String(error));
  });
});

void initialize();
