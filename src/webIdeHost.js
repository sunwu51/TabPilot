/* global chrome */
import { chromeStorageVfs } from "./utils/chromeStorageVfs";
import {
  getWebIdeFilePath,
  getWebIdeProjectPath,
  requireWebIdeProject
} from "./utils/webIdeProjects";
import "./webIdeHost.css";

const params = new URL(location.href).searchParams;
const projectId = params.get("id") || "";
const frame = document.getElementById("webide-frame");
const errorPanel = document.getElementById("webide-host-error");
const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
let project = null;
let ready = false;
let operationQueue = Promise.resolve();

function showError(error) {
  errorPanel.textContent = error?.message || String(error);
  errorPanel.hidden = false;
}

function postProject() {
  if (!ready || !project || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: "webide:load", nonce, project }, "*");
}

async function refreshProject() {
  project = await requireWebIdeProject(projectId);
  postProject();
}

async function initialize() {
  try {
    await refreshProject();
    const url = new URL(chrome.runtime.getURL("webide.html"));
    url.searchParams.set("embedded", "1");
    url.searchParams.set("bridge", nonce);
    frame.src = url.toString();
    chromeStorageVfs.watch(getWebIdeProjectPath(projectId), () => {
      operationQueue = operationQueue.then(refreshProject).catch(showError);
    });
  } catch (error) {
    showError(error);
  }
}

window.addEventListener("message", event => {
  if (event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
  if (event.data.type === "webide:ready") {
    ready = true;
    postProject();
    return;
  }
  if (event.data.type !== "webide:write" && event.data.type !== "webide:delete") return;
  const operationId = Number(event.data.operationId);
  const relativePath = String(event.data.path || "");
  operationQueue = operationQueue.then(async () => {
    const path = getWebIdeFilePath(projectId, relativePath);
    if (event.data.type === "webide:delete") {
      await chromeStorageVfs.unlink(path);
    } else {
      await chromeStorageVfs.writeFile(path, String(event.data.content ?? ""), {
        expireAt: project.expireAt
      });
    }
    await refreshProject();
    frame.contentWindow?.postMessage({ type: "webide:saved", nonce, operationId, path: relativePath }, "*");
  }).catch(showError);
});

void initialize();
