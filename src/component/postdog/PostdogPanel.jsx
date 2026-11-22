/* global chrome */
/* eslint-disable react/prop-types, react-hooks/exhaustive-deps */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Radio, RadioGroup, TabBar } from "@sunwu51/camel-ui";
import toast from "react-hot-toast";
import {
  POSTDOG_ACTIVE_ENVIRONMENT_KEY,
  POSTDOG_ENVIRONMENTS_KEY,
  POSTDOG_FLOW_RUNS_KEY,
  POSTDOG_FLOWS_KEY,
  POSTDOG_FOLDERS_KEY,
  POSTDOG_HISTORY_KEY,
  POSTDOG_REQUESTS_KEY
} from "../../api/postdog";
import { formatJsonWithComments, parseJsonWithComments } from "../../api/postdog/json";
import { tr, useI18n } from "../../i18n";
import CodeEditor from "./CodeEditor";
import FlowPanel from "./FlowPanel";
import { runFlow } from "../../api/postdog/flowRunner";
import {
  HeaderTable,
  HistoryList,
  JsonViewer,
  StatusBadge,
  KeyValueEditor,
  Modal,
  MultipartEditor
} from "./PostdogParts";
import { DEFAULT_USER_AGENT, flowStatusLabel, formatDateTime, syncContentTypeHeader } from "./postdogUtils";
import useAutosave from "./useAutosave";
import { UiButton, UiInput, UiSelect } from "../ui/Controls";
import "./postdog.css";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_TYPES = ["none", "json", "text", "form", "multipart"];
const EMPTY_REQUEST = {
  name: "New Request",
  method: "GET",
  url: "",
  folderId: null,
  headers: [{ key: "User-Agent", value: DEFAULT_USER_AGENT, enabled: true }],
  query: [],
  body: { type: "none", text: "", fields: [] },
  preScript: "",
  postScript: ""
};
const SIDEBAR_WIDTH_KEY = "postdogSidebarWidth";
const SPLIT_RATIO_KEY = "postdogSplitRatio";
const COLLAPSED_FOLDERS_KEY = "postdogCollapsedFolders";
const LAST_REQUEST_KEY = "postdogLastRequestId";
const REQUEST_TAB_KEY = "postdogRequestTab";
const SIDEBAR_MODE_KEY = "postdogSidebarMode";
const LAST_FLOW_KEY = "postdogLastFlowId";
const DEFAULT_SIDEBAR_WIDTH = 250;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 640;

const requestKey = id => `request:${id}`;
const folderKey = id => `folder:${id}`;
const envKey = id => `env:${id}`;
const flowKey = id => `flow:${id}`;

export default function PostdogPanel() {
  useI18n(); // re-render when the UI language changes
  const [folders, setFolders] = useState([]);
  const [requests, setRequests] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [activeEnvironmentId, setActiveEnvironmentId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraftState] = useState(null);
  const [responses, setResponses] = useState({});
  const [runningIds, setRunningIds] = useState(() => new Set());
  const [requestTab, setRequestTab] = useState(() => readLocal(REQUEST_TAB_KEY, "params"));
  const [responseTab, setResponseTab] = useState("body");
  const [bodyView, setBodyView] = useState("tree");
  const [historyRuns, setHistoryRuns] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set(readJsonLocal(COLLAPSED_FOLDERS_KEY, [])));
  const [search, setSearch] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => clamp(Number(readLocal(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH)), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
  const [splitRatio, setSplitRatio] = useState(() => clampRatio(Number(readLocal(SPLIT_RATIO_KEY, 0.5))));
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [folderModalId, setFolderModalId] = useState("");
  const [curlModalOpen, setCurlModalOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState(() => readLocal(SIDEBAR_MODE_KEY, "requests") === "flows" ? "flows" : "requests");
  const [flows, setFlows] = useState([]);
  const [selectedFlowId, setSelectedFlowIdState] = useState("");
  const [flowRuns, setFlowRuns] = useState([]);
  const [flowRunsLoading, setFlowRunsLoading] = useState(false);
  const [liveRun, setLiveRun] = useState(null);
  const [selectedFlowRunId, setSelectedFlowRunId] = useState("");
  const flowAbortRef = useRef(null);
  const liveRunIdRef = useRef("");
  const selectedFlowIdRef = useRef("");
  const flowRunsTimerRef = useRef(null);

  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const dragRef = useRef(null);
  const draftRef = useRef(null);
  const requestsRef = useRef([]);
  const knownRef = useRef(new Map()); // entity key -> updatedAt we already have locally
  const loadTimerRef = useRef(null);
  const importFileRef = useRef(null);
  const splitRef = useRef(null);
  const urlInputRef = useRef(null);
  requestsRef.current = requests;

  const autosave = useAutosave({
    save: saveEntity,
    onSaved: (key, result) => {
      if (result?.updatedAt) knownRef.current.set(key, Number(result.updatedAt));
    },
    onError: (_key, error) => {
      toast.error(`${tr("自动保存失败", "Autosave failed")}: ${error?.message || error}`, { id: "postdog-autosave-error" });
    }
  });
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;

  // ---------------------------------------------------------------- loading / sync

  useEffect(() => {
    void loadAll({ initial: true });
    function handleStorageChange(changes, areaName) {
      if (areaName !== "local") return;
      if (changes[POSTDOG_HISTORY_KEY] && draftRef.current?.id) void loadHistory(draftRef.current.id);
      if (changes[POSTDOG_FLOW_RUNS_KEY] && selectedFlowIdRef.current) {
        clearTimeout(flowRunsTimerRef.current);
        flowRunsTimerRef.current = setTimeout(() => { void loadFlowRuns(selectedFlowIdRef.current); }, 150);
      }
      if (changes[POSTDOG_FOLDERS_KEY] || changes[POSTDOG_REQUESTS_KEY] || changes[POSTDOG_ENVIRONMENTS_KEY] || changes[POSTDOG_ACTIVE_ENVIRONMENT_KEY] || changes[POSTDOG_FLOWS_KEY]) {
        clearTimeout(loadTimerRef.current);
        loadTimerRef.current = setTimeout(() => { void loadAll(); }, 120);
      }
    }
    function flushOnHide() {
      if (document.visibilityState === "hidden") void autosaveRef.current.flushAll();
    }
    function flushOnUnload() {
      void autosaveRef.current.flushAll();
    }
    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("beforeunload", flushOnUnload);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
      document.removeEventListener("visibilitychange", flushOnHide);
      window.removeEventListener("beforeunload", flushOnUnload);
      clearTimeout(loadTimerRef.current);
      clearTimeout(flowRunsTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (sidebarMode === "flows") void runSelectedFlow();
        else void runRequest();
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void autosaveRef.current.flushAll().then(() => toast.success(tr("已保存", "Saved"), { id: "postdog-saved", duration: 1000 }));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    setSelectedHistoryRunId("");
    void loadHistory(draft?.id);
  }, [draft?.id]);

  useEffect(() => {
    setSelectedFlowRunId("");
    setFlowRuns([]);
    void loadFlowRuns(selectedFlowId);
  }, [selectedFlowId]);

  async function saveEntity(key, value) {
    const [type] = key.split(":");
    let res;
    if (type === "request") {
      res = await sendPostdog("save_request", { request: { ...value, name: String(value.name || "").trim() || "Untitled" } });
    } else if (type === "folder") {
      res = await sendPostdog("save_folder", { folder: { ...value, name: String(value.name || "").trim() || "Folder" } });
    } else if (type === "env") {
      res = await sendPostdog("save_environment", { environment: { ...value, name: String(value.name || "").trim() || "Environment" } });
    } else if (type === "flow") {
      res = await sendPostdog("save_flow", { flow: { ...value, name: String(value.name || "").trim() || "Flow" } });
    } else {
      throw new Error(`unknown entity ${key}`);
    }
    if (!res?.success) throw new Error(res?.error || "save failed");
    return res.data;
  }

  /** Merge stored entities with local ones without clobbering unsaved/just-saved local edits. */
  function mergeStored(storedList, keyOf, localList) {
    const localById = new Map((localList || []).map(item => [item.id, item]));
    return storedList.map(stored => {
      const key = keyOf(stored.id);
      const pending = autosaveRef.current.pending(key);
      if (pending) return pending;
      const local = localById.get(stored.id);
      const known = knownRef.current.get(key);
      if (local && known != null && Number(stored.updatedAt) <= known) return local;
      knownRef.current.set(key, Number(stored.updatedAt) || 0);
      return stored;
    });
  }

  async function loadAll({ initial = false } = {}) {
    try {
      await loadAllUnsafe({ initial });
      setLoadError("");
    } catch (error) {
      setLoadError(error?.message || String(error));
    } finally {
      setLoaded(true);
    }
  }

  async function loadAllUnsafe({ initial = false } = {}) {
    const res = await sendPostdog("list_all");
    if (!res?.success) {
      throw new Error(res?.error || tr("加载 Postdog 失败", "Failed to load Postdog"));
    }
    const storedRequests = res.data.requests || [];

    // Keep the open request in sync with external changes (AI tools, other tabs),
    // but never overwrite what the user is typing.
    const current = draftRef.current;
    let nextDraft;
    if (current?.id) {
      const key = requestKey(current.id);
      const stored = storedRequests.find(item => item.id === current.id);
      if (!stored && !autosaveRef.current.hasPending(key)) {
        nextDraft = null;
      } else if (stored && !autosaveRef.current.hasPending(key) && Number(stored.updatedAt) > (knownRef.current.get(key) ?? 0)) {
        nextDraft = clone(stored);
      }
    }

    setFolders(prev => mergeStored(res.data.folders || [], folderKey, prev));
    setEnvironments(prev => mergeStored(res.data.environments || [], envKey, prev));
    setRequests(prev => mergeStored(storedRequests, requestKey, prev));
    setActiveEnvironmentId(res.data.activeEnvironmentId || "");
    const storedFlows = res.data.flows || [];
    setFlows(prev => mergeStored(storedFlows, flowKey, prev));
    const currentFlowId = selectedFlowIdRef.current;
    if (!currentFlowId || (!storedFlows.some(item => item.id === currentFlowId) && !autosaveRef.current.hasPending(flowKey(currentFlowId)))) {
      const lastFlowId = initial ? readLocal(LAST_FLOW_KEY, "") : "";
      setSelectedFlowId((storedFlows.find(item => item.id === lastFlowId) || storedFlows[0])?.id || "");
    }

    if (nextDraft !== undefined) {
      if (nextDraft) knownRef.current.set(requestKey(nextDraft.id), Number(nextDraft.updatedAt) || 0);
      setDraft(nextDraft);
    }
    if (!draftRef.current) {
      const lastId = initial ? readLocal(LAST_REQUEST_KEY, "") : "";
      const target = storedRequests.find(item => item.id === lastId) || storedRequests[0];
      if (target) {
        knownRef.current.set(requestKey(target.id), Number(target.updatedAt) || 0);
        setDraft(clone(target));
      }
    }
  }

  function setDraft(next) {
    draftRef.current = next;
    setDraftState(next);
    if (next?.id) {
      try { localStorage.setItem(LAST_REQUEST_KEY, next.id); } catch { /* ignore */ }
      if (next.folderId) {
        setCollapsedFolders(prev => {
          if (!prev.has(next.folderId)) return prev;
          const copy = new Set(prev);
          copy.delete(next.folderId);
          return copy;
        });
      }
    }
  }

  // ---------------------------------------------------------------- request editing

  function updateDraft(patch) {
    const current = draftRef.current;
    if (!current) return;
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
    draftRef.current = next;
    setDraftState(next);
    setRequests(list => list.map(item => item.id === next.id ? next : item));
    autosave.schedule(requestKey(next.id), next);
  }

  function updateBody(patch) {
    updateDraft(current => {
      const body = { type: "none", text: "", fields: [], ...(current.body || {}), ...patch };
      const headers = patch.type && patch.type !== current.body?.type
        ? syncContentTypeHeader(current.headers, patch.type)
        : current.headers;
      return { ...current, headers, body };
    });
  }

  function selectRequest(id) {
    if (draftRef.current?.id === id) return;
    if (draftRef.current?.id) void autosave.flush(requestKey(draftRef.current.id));
    const target = requestsRef.current.find(item => item.id === id);
    if (!target) return;
    if (!knownRef.current.has(requestKey(id))) knownRef.current.set(requestKey(id), Number(target.updatedAt) || 0);
    setDraft(clone(target));
  }

  async function createRequest(folderId = null, base = null) {
    const request = base ? { ...clone(base), id: undefined, name: `${base.name} copy` } : { ...clone(EMPTY_REQUEST), folderId };
    const res = await sendPostdog("save_request", { request });
    if (!res?.success) {
      toast.error(res?.error || tr("创建失败", "Create failed"));
      return;
    }
    knownRef.current.set(requestKey(res.data.id), Number(res.data.updatedAt) || 0);
    if (draftRef.current?.id) void autosave.flush(requestKey(draftRef.current.id));
    setRequests(list => [res.data, ...list.filter(item => item.id !== res.data.id)]);
    setDraft(clone(res.data));
    if (!base) {
      setTimeout(() => urlInputRef.current?.focus(), 30);
    }
  }

  async function deleteRequest(request) {
    if (!request?.id || !window.confirm(tr(`删除请求「${request.name}」？`, `Delete request "${request.name}"?`))) return;
    autosave.discard(requestKey(request.id));
    const res = await sendPostdog("delete_request", { id: request.id });
    if (!res?.success) {
      toast.error(res?.error || tr("删除失败", "Delete failed"));
      return;
    }
    const remaining = requestsRef.current.filter(item => item.id !== request.id);
    setRequests(remaining);
    setResponses(prev => {
      const next = { ...prev };
      delete next[request.id];
      return next;
    });
    if (draftRef.current?.id === request.id) {
      const sameFolder = remaining.find(item => item.folderId === request.folderId);
      setDraft(sameFolder || remaining[0] ? clone(sameFolder || remaining[0]) : null);
    }
    toast.success(tr("请求已删除", "Request deleted"));
  }

  async function runRequest() {
    const current = draftRef.current;
    if (!current?.id) return;
    if (!String(current.url || "").trim()) {
      toast.error(tr("请先填写 URL", "Enter a URL first"));
      urlInputRef.current?.focus();
      return;
    }
    const id = current.id;
    if (runningIds.has(id)) return;
    setRunningIds(prev => new Set(prev).add(id));
    try {
      await autosave.flush(requestKey(id));
      if (autosave.hasPending(requestKey(id))) {
        toast.error(tr("请求保存失败，未发送", "Could not save the request, not sent"));
        return;
      }
      const res = await sendPostdog("run_request", { id });
      if (!res?.success) {
        toast.error(res?.error || tr("执行失败", "Run failed"));
        return;
      }
      setResponses(prev => ({ ...prev, [id]: res.data }));
      const scriptError = (res.data.logs || []).find(log => log.level === "error");
      if (draftRef.current?.id === id) {
        setSelectedHistoryRunId(res.data.runId || "");
        setResponseTab(tab => (scriptError ? "logs" : tab === "history" ? "body" : tab));
        void loadHistory(id);
      }
      if (scriptError) {
        toast.error(`${tr("脚本出错", "Script error")} (${scriptError.phase}): ${scriptError.message}`, { duration: 6000 });
      }
    } finally {
      setRunningIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function exportCurrentCurl() {
    const current = draftRef.current;
    if (!current) return;
    const res = await sendPostdog("export_curl", { request: current });
    if (!res?.success) {
      toast.error(res?.error || tr("复制失败", "Copy failed"));
      return;
    }
    await copyText(res.data.text);
    toast.success(activeEnvironment
      ? tr(`curl 已复制（已代入环境「${activeEnvironment.name}」的变量）`, `curl copied (variables from "${activeEnvironment.name}" applied)`)
      : tr("curl 已复制", "curl copied"));
  }

  function beautifyRequestJson() {
    try {
      updateBody({ text: formatJsonWithComments(draftRef.current?.body?.text || "", 2) });
    } catch (error) {
      toast.error(error?.message || tr("JSON 格式错误", "Invalid JSON"));
    }
  }

  // ---------------------------------------------------------------- history

  async function loadHistory(requestId) {
    const id = String(requestId || "").trim();
    if (!id) {
      setHistoryRuns([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await sendPostdog("list_history", { requestId: id });
      if (res?.success && draftRef.current?.id === id) setHistoryRuns(res.data || []);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openHistoryRun(runId) {
    const id = draftRef.current?.id;
    const res = await sendPostdog("get_history_run", { runId });
    if (!res?.success || !res.data) {
      toast.error(res?.error || tr("历史记录不存在", "History run not found"));
      return;
    }
    setSelectedHistoryRunId(runId);
    if (id) {
      setResponses(prev => ({
        ...prev,
        [id]: {
          runId: res.data.runId || res.data.id,
          request: res.data.request,
          response: res.data.response,
          durationMs: res.data.durationMs,
          tests: res.data.tests || {},
          logs: res.data.logs || [],
          historyCreatedAt: res.data.createdAt
        }
      }));
    }
    setResponseTab("body");
  }

  // ---------------------------------------------------------------- folders

  async function createFolder() {
    const res = await sendPostdog("save_folder", { folder: { name: tr("新文件夹", "New Folder") } });
    if (!res?.success) {
      toast.error(res?.error || tr("创建失败", "Create failed"));
      return;
    }
    knownRef.current.set(folderKey(res.data.id), Number(res.data.updatedAt) || 0);
    setFolders(list => [res.data, ...list.filter(item => item.id !== res.data.id)]);
    setFolderModalId(res.data.id);
  }

  function updateFolder(folder) {
    setFolders(list => list.map(item => item.id === folder.id ? folder : item));
    autosave.schedule(folderKey(folder.id), folder);
  }

  async function deleteFolder(folder) {
    if (!folder?.id) return;
    const doomed = descendantFolderIds(folders, folder.id);
    doomed.add(folder.id);
    const count = requestsRef.current.filter(item => doomed.has(item.folderId)).length;
    const message = doomed.size > 1
      ? tr(`删除文件夹「${folder.name}」及其 ${doomed.size - 1} 个子文件夹和 ${count} 个请求？`, `Delete folder "${folder.name}", its ${doomed.size - 1} subfolder(s) and ${count} request(s)?`)
      : count
      ? tr(`删除文件夹「${folder.name}」以及里面的 ${count} 个请求？`, `Delete folder "${folder.name}" and its ${count} request(s)?`)
      : tr(`删除文件夹「${folder.name}」？`, `Delete folder "${folder.name}"?`);
    if (!window.confirm(message)) return;
    autosave.discard(folderKey(folder.id));
    const res = await sendPostdog("delete_folder", { id: folder.id });
    if (!res?.success) {
      toast.error(res?.error || tr("删除文件夹失败", "Failed to delete folder"));
      return;
    }
    setFolderModalId("");
    setFolders(list => list.filter(item => !doomed.has(item.id)));
    const remaining = requestsRef.current.filter(item => !doomed.has(item.folderId));
    for (const item of requestsRef.current) {
      if (doomed.has(item.folderId)) autosave.discard(requestKey(item.id));
    }
    for (const id of doomed) autosave.discard(folderKey(id));
    setRequests(remaining);
    if (doomed.has(draftRef.current?.folderId)) setDraft(remaining[0] ? clone(remaining[0]) : null);
    toast.success(tr("文件夹已删除", "Folder deleted"));
  }

  function toggleFolder(folderId) {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  // ---------------------------------------------------------------- drag & drop (sidebar tree)

  function startDrag(event, type, id) {
    dragRef.current = { type, id };
    event.dataTransfer.effectAllowed = "move";
    try { event.dataTransfer.setData("text/plain", `${type}:${id}`); } catch { /* ignore */ }
    setDragging({ type, id });
  }

  function endDrag() {
    dragRef.current = null;
    setDragging(null);
    setDropTarget(null);
  }

  function hoverDrop(event, kind, id) {
    const drag = dragRef.current;
    if (!drag || searchText) return;
    let pos = null;
    if (kind === "request") {
      if (drag.type !== "request" || drag.id === id) return;
      pos = isUpperHalf(event) ? "before" : "after";
    } else if (kind === "folder") {
      if (drag.type === "folder") {
        if (drag.id === id || descendantFolderIds(folders, drag.id).has(id)) return;
        pos = dropZone(event);
      } else {
        pos = "into";
      }
    } else if (kind === "root") {
      pos = "end";
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(prev => (prev && prev.kind === kind && prev.id === id && prev.pos === pos ? prev : { kind, id, pos }));
  }

  function dropOn(event, kind, id) {
    const drag = dragRef.current;
    const target = dropTarget;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    if (!drag || !target || target.kind !== kind || target.id !== id) return;
    void applyDrop(drag, target);
  }

  async function applyDrop(drag, target) {
    let nextFolders = folders;
    let nextRequests = requests;
    if (drag.type === "folder") {
      const dragged = folders.find(item => item.id === drag.id);
      if (!dragged) return;
      const rest = folders.filter(item => item.id !== drag.id);
      if (target.kind === "folder") {
        const at = rest.findIndex(item => item.id === target.id);
        if (at < 0) return;
        if (target.pos === "into") {
          rest.push({ ...dragged, parentId: target.id });
          setCollapsedFolders(prev => {
            if (!prev.has(target.id)) return prev;
            const copy = new Set(prev);
            copy.delete(target.id);
            try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...copy])); } catch { /* ignore */ }
            return copy;
          });
        } else {
          rest.splice(target.pos === "before" ? at : at + 1, 0, { ...dragged, parentId: rest[at].parentId || null });
        }
      } else {
        rest.push({ ...dragged, parentId: null });
      }
      nextFolders = rest;
    } else {
      const dragged = requests.find(item => item.id === drag.id);
      if (!dragged) return;
      const rest = requests.filter(item => item.id !== drag.id);
      let moved = dragged;
      if (target.kind === "request") {
        const at = rest.findIndex(item => item.id === target.id);
        if (at < 0) return;
        moved = { ...dragged, folderId: rest[at].folderId || null };
        rest.splice(target.pos === "before" ? at : at + 1, 0, moved);
      } else if (target.kind === "folder") {
        moved = { ...dragged, folderId: target.id };
        let last = -1;
        rest.forEach((item, index) => { if (item.folderId === target.id) last = index; });
        rest.splice(last < 0 ? rest.length : last + 1, 0, moved);
        setCollapsedFolders(prev => {
          if (!prev.has(target.id)) return prev;
          const copy = new Set(prev);
          copy.delete(target.id);
          try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...copy])); } catch { /* ignore */ }
          return copy;
        });
      } else {
        moved = { ...dragged, folderId: null };
        rest.push(moved);
      }
      nextRequests = rest;
      if (draftRef.current?.id === moved.id && draftRef.current.folderId !== moved.folderId) {
        draftRef.current = { ...draftRef.current, folderId: moved.folderId };
        setDraftState(draftRef.current);
      }
    }
    // Commit pending edits first so the reorder never races an autosave on the same arrays.
    await autosave.flushAll();
    setFolders(nextFolders);
    setRequests(nextRequests);
    const res = await sendPostdog("reorder_tree", {
      folders: nextFolders.map(item => ({ id: item.id, parentId: item.parentId || null })),
      requests: nextRequests.map(item => ({ id: item.id, folderId: item.folderId || null }))
    });
    if (!res?.success) {
      toast.error(res?.error || tr("排序保存失败", "Failed to save order"));
      await loadAll();
    }
  }

  // ---------------------------------------------------------------- flows (编排)

  function setSelectedFlowId(id) {
    selectedFlowIdRef.current = id || "";
    setSelectedFlowIdState(id || "");
    if (id) {
      try { localStorage.setItem(LAST_FLOW_KEY, id); } catch { /* ignore */ }
    }
  }

  function changeSidebarMode(mode) {
    setSidebarMode(mode);
    try { localStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch { /* ignore */ }
  }

  async function loadFlowRuns(flowId) {
    const id = String(flowId || "").trim();
    if (!id) {
      setFlowRuns([]);
      return;
    }
    setFlowRunsLoading(true);
    try {
      const res = await sendPostdog("list_flow_runs", { flowId: id });
      if (res?.success && selectedFlowIdRef.current === id) {
        setFlowRuns((res.data || []).map(run => markInterruptedRun(run, liveRunIdRef.current)));
      }
    } finally {
      setFlowRunsLoading(false);
    }
  }

  async function createFlow() {
    const res = await sendPostdog("save_flow", { flow: { name: tr("新编排", "New Flow"), steps: [] } });
    if (!res?.success) {
      toast.error(res?.error || tr("创建编排失败", "Failed to create flow"));
      return;
    }
    knownRef.current.set(flowKey(res.data.id), Number(res.data.updatedAt) || 0);
    setFlows(list => [res.data, ...list.filter(item => item.id !== res.data.id)]);
    setSelectedFlowId(res.data.id);
  }

  function updateFlow(flow) {
    setFlows(list => list.map(item => item.id === flow.id ? flow : item));
    autosave.schedule(flowKey(flow.id), flow);
  }

  async function deleteFlow(flow) {
    if (!flow?.id || !window.confirm(tr(`删除编排「${flow.name}」及其运行记录？`, `Delete flow "${flow.name}" and its runs?`))) return;
    autosave.discard(flowKey(flow.id));
    const res = await sendPostdog("delete_flow", { id: flow.id });
    if (!res?.success) {
      toast.error(res?.error || tr("删除失败", "Delete failed"));
      return;
    }
    const remaining = flows.filter(item => item.id !== flow.id);
    setFlows(remaining);
    if (selectedFlowIdRef.current === flow.id) setSelectedFlowId(remaining[0]?.id || "");
    if (liveRun?.flowId === flow.id) setLiveRun(null);
    toast.success(tr("编排已删除", "Flow deleted"));
  }

  async function runSelectedFlow() {
    const flow = flows.find(item => item.id === selectedFlowIdRef.current);
    if (!flow || flowAbortRef.current) return;
    if (backgroundFlowRun?.flowId === flow.id) {
      toast.error(tr("这个编排正在由助手在后台运行", "This flow is already running in the background (assistant)"));
      return;
    }
    if (flow.steps.length === 0) {
      toast.error(tr("编排里还没有步骤", "This flow has no steps"));
      return;
    }
    await autosave.flushAll();
    if (autosave.hasPending()) {
      toast.error(tr("有修改保存失败，未运行", "Some changes could not be saved, not run"));
      return;
    }
    const controller = new AbortController();
    flowAbortRef.current = controller;
    setSelectedFlowRunId("");
    let saveChain = Promise.resolve();
    const persist = run => {
      saveChain = saveChain.then(() => sendPostdog("save_flow_run", { run })).catch(() => {});
    };
    try {
      const finalRun = await runFlow({
        flow: clone(flow),
        requests: requestsRef.current,
        send: sendPostdog,
        signal: controller.signal,
        onUpdate: run => {
          liveRunIdRef.current = run.runId;
          setLiveRun(run);
          persist(run);
        }
      });
      await saveChain;
      const message = `${flow.name}: ${flowStatusLabel(finalRun.status)}`;
      if (finalRun.status === "passed") toast.success(message);
      else if (finalRun.status === "failed") toast.error(message);
      else toast(message);
    } catch (error) {
      toast.error(error?.message || tr("编排运行出错", "Flow run failed"));
    } finally {
      flowAbortRef.current = null;
      liveRunIdRef.current = "";
      void loadFlowRuns(flow.id);
    }
  }

  function stopFlow() {
    if (flowAbortRef.current) {
      flowAbortRef.current.abort();
      return;
    }
    if (backgroundFlowRun) {
      void sendPostdog("stop_flow_run", { runId: backgroundFlowRun.runId }).then(res => {
        if (!res?.success || !res.data?.stopped) toast.error(tr("没能停止这次后台运行（可能已结束）", "Could not stop this background run (it may have finished)"));
      });
    }
  }

  function openRequestFromFlow(requestId) {
    changeSidebarMode("requests");
    selectRequest(requestId);
  }

  // ---------------------------------------------------------------- environments

  async function createEnvironment() {
    const res = await sendPostdog("save_environment", { environment: { name: tr("新环境", "New Environment"), variables: [] } });
    if (!res?.success) {
      toast.error(res?.error || tr("创建环境失败", "Failed to create environment"));
      return null;
    }
    knownRef.current.set(envKey(res.data.id), Number(res.data.updatedAt) || 0);
    setEnvironments(list => [res.data, ...list.filter(item => item.id !== res.data.id)]);
    if (!activeEnvironmentId) await switchEnvironment(res.data.id);
    return res.data;
  }

  function updateEnvironment(env) {
    setEnvironments(list => list.map(item => item.id === env.id ? env : item));
    autosave.schedule(envKey(env.id), env);
  }

  async function deleteEnvironment(env) {
    if (!env?.id || !window.confirm(tr(`删除环境「${env.name}」？`, `Delete environment "${env.name}"?`))) return;
    autosave.discard(envKey(env.id));
    const res = await sendPostdog("delete_environment", { id: env.id });
    if (!res?.success) {
      toast.error(res?.error || tr("删除失败", "Delete failed"));
      return;
    }
    setEnvironments(list => list.filter(item => item.id !== env.id));
    await loadAll();
  }

  async function switchEnvironment(id) {
    setActiveEnvironmentId(id);
    const res = await sendPostdog("set_active_environment", { id });
    if (!res?.success) toast.error(res?.error || tr("切换环境失败", "Failed to switch environment"));
  }

  // ---------------------------------------------------------------- import / export

  async function importCurlText(text, folderId) {
    if (!String(text || "").trim()) return false;
    const res = await sendPostdog("import_curl", { text, folderId: folderId || null });
    if (!res?.success) {
      toast.error(res?.error || tr("导入失败", "Import failed"));
      return false;
    }
    knownRef.current.set(requestKey(res.data.id), Number(res.data.updatedAt) || 0);
    if (draftRef.current?.id) void autosave.flush(requestKey(draftRef.current.id));
    setRequests(list => [res.data, ...list.filter(item => item.id !== res.data.id)]);
    setDraft(clone(res.data));
    toast.success(tr("curl 已导入", "curl imported"));
    return true;
  }

  async function exportJson() {
    await autosave.flushAll();
    const res = await sendPostdog("export_json");
    if (res?.success) downloadText(`postdog-${formatDate(new Date())}.json`, res.data.text, "application/json;charset=utf-8");
    else toast.error(res?.error || tr("导出失败", "Export failed"));
  }

  async function importJsonFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const res = await sendPostdog("import_json", { text });
      if (!res?.success) throw new Error(res?.error || tr("导入失败", "Import failed"));
      toast.success(tr("Postdog JSON 已导入", "Postdog JSON imported"));
      await loadAll();
    } catch (error) {
      toast.error(error?.message || tr("导入失败", "Import failed"));
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  }

  // ---------------------------------------------------------------- layout drag

  function startSidebarResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latest = startWidth;
    document.body.classList.add("pd-resizing-x");
    function move(moveEvent) {
      latest = clamp(startWidth + moveEvent.clientX - startX, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
      setSidebarWidth(latest);
    }
    function up() {
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(latest)); } catch { /* ignore */ }
      document.body.classList.remove("pd-resizing-x");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function resetSidebarWidth() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_SIDEBAR_WIDTH)); } catch { /* ignore */ }
  }

  function startSplitResize(event) {
    event.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vertical = getComputedStyle(container).flexDirection === "column";
    let latest = splitRatio;
    document.body.classList.add(vertical ? "pd-resizing-y" : "pd-resizing-x");
    function move(moveEvent) {
      latest = clampRatio(vertical
        ? (moveEvent.clientY - rect.top) / rect.height
        : (moveEvent.clientX - rect.left) / rect.width);
      setSplitRatio(latest);
    }
    function up() {
      try { localStorage.setItem(SPLIT_RATIO_KEY, String(latest)); } catch { /* ignore */ }
      document.body.classList.remove("pd-resizing-x", "pd-resizing-y");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ---------------------------------------------------------------- derived data

  const activeEnvironment = environments.find(item => item.id === activeEnvironmentId) || null;
  const envVars = useMemo(() => {
    const out = {};
    for (const item of activeEnvironment?.variables || []) {
      if (item.enabled !== false && item.key) out[item.key] = item.value;
    }
    return out;
  }, [activeEnvironment]);

  // Same set as envVars, plus the secret flag so the editor can mask values on hover.
  const templateVars = useMemo(() => {
    const out = {};
    for (const item of activeEnvironment?.variables || []) {
      if (item.enabled !== false && item.key) out[item.key] = { value: item.value, secret: item.secret === true };
    }
    return out;
  }, [activeEnvironment]);

  const searchText = search.trim().toLowerCase();
  const tree = useMemo(() => {
    const matches = request => !searchText || `${request.name} ${request.method} ${request.url}`.toLowerCase().includes(searchText);
    const folderIds = new Set(folders.map(folder => folder.id));
    const byFolder = new Map(folders.map(folder => [folder.id, []]));
    const loose = [];
    for (const request of requests) {
      if (!matches(request)) continue;
      if (request.folderId && folderIds.has(request.folderId)) byFolder.get(request.folderId).push(request);
      else loose.push(request);
    }
    const childFolders = new Map();
    const roots = [];
    for (const folder of folders) {
      if (folder.parentId && folderIds.has(folder.parentId)) {
        if (!childFolders.has(folder.parentId)) childFolders.set(folder.parentId, []);
        childFolders.get(folder.parentId).push(folder);
      } else {
        roots.push(folder);
      }
    }
    // With a search active, keep only folders that match or contain a match.
    const visible = new Map();
    const isVisible = (folder, trail = new Set()) => {
      if (visible.has(folder.id)) return visible.get(folder.id);
      if (trail.has(folder.id)) return false;
      trail.add(folder.id);
      let result = !searchText || byFolder.get(folder.id).length > 0 || folder.name.toLowerCase().includes(searchText);
      for (const child of childFolders.get(folder.id) || []) if (isVisible(child, trail)) result = true;
      visible.set(folder.id, result);
      return result;
    };
    const visibleFolders = roots.filter(folder => isVisible(folder));
    return { byFolder, loose, visibleFolders, childFolders, isVisible };
  }, [folders, requests, searchText]);
  const folderOptions = useMemo(() => flattenFolders(folders).map(({ folder, depth }) => ({
    value: folder.id,
    label: `${"  ".repeat(depth)}📁 ${folder.name}`
  })), [folders]);

  const currentFolder = draft?.folderId ? folders.find(item => item.id === draft.folderId) : null;
  const currentResponse = draft?.id ? responses[draft.id] : null;
  const running = draft?.id ? runningIds.has(draft.id) : false;
  const bodyType = draft?.body?.type || "none";
  const bodyText = draft?.body?.text || "";
  const jsonBodyError = useMemo(() => {
    if (bodyType !== "json" || !bodyText.trim()) return "";
    // Template placeholders like {{id}} (unquoted) are valid after substitution.
    try {
      parseJsonWithComments(bodyText.replace(/\{\{[^{}]+\}\}/g, "0"));
      return "";
    } catch (error) {
      return error?.message || "JSON";
    }
  }, [bodyType, bodyText]);

  const urlPreview = useMemo(() => buildUrlPreview(draft?.url || "", draft?.query || [], envVars), [draft?.url, draft?.query, envVars]);
  const folderModal = folderModalId ? folders.find(item => item.id === folderModalId) : null;
  const selectedFlow = flows.find(item => item.id === selectedFlowId) || null;
  const flowRunning = !!liveRun && liveRun.status === "running";
  const shownFlowRun = useMemo(() => {
    if (!selectedFlow) return null;
    const live = liveRun?.flowId === selectedFlow.id ? liveRun : null;
    if (selectedFlowRunId) {
      if (live?.runId === selectedFlowRunId) return live;
      return flowRuns.find(item => item.runId === selectedFlowRunId) || live;
    }
    // Newest of the page's own run and the stored runs (which include assistant / MCP runs).
    const stored = flowRuns[0] || null;
    if (!live) return stored;
    if (!stored || stored.runId === live.runId) return live;
    return (Number(stored.startedAt) || 0) > (Number(live.startedAt) || 0) ? stored : live;
  }, [selectedFlow, liveRun, selectedFlowRunId, flowRuns]);
  // A run started by the assistant / MCP that is still going (stoppable from here).
  const backgroundFlowRun = shownFlowRun?.status === "running" && shownFlowRun.source === "background" ? shownFlowRun : null;

  function changeRequestTab(tab) {
    setRequestTab(tab);
    try { localStorage.setItem(REQUEST_TAB_KEY, tab); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- render

  function renderFolder(folder, trail = new Set()) {
    if (trail.has(folder.id)) return null;
    const nextTrail = new Set(trail).add(folder.id);
    const children = tree.byFolder.get(folder.id) || [];
    const subfolders = (tree.childFolders.get(folder.id) || []).filter(child => tree.isVisible(child));
    const collapsed = !searchText && collapsedFolders.has(folder.id);
    const hasScripts = !!(folder.preScript?.trim() || folder.postScript?.trim());
    const dropPos = dropTarget?.kind === "folder" && dropTarget.id === folder.id ? dropTarget.pos : "";
    return (
      <div key={folder.id} className="pd-folder">
        <div
          className={`pd-folder-row${dragging?.id === folder.id ? " dragging" : ""}${dropPos ? ` drop-${dropPos}` : ""}`}
          draggable={!searchText}
          onDragStart={e => { e.stopPropagation(); startDrag(e, "folder", folder.id); }}
          onDragEnd={endDrag}
          onDragOver={e => hoverDrop(e, "folder", folder.id)}
          onDrop={e => dropOn(e, "folder", folder.id)}
          onDoubleClick={() => setFolderModalId(folder.id)}
        >
          <button type="button" className="pd-folder-toggle" onClick={() => toggleFolder(folder.id)} title={folder.name}>
            <span className={`pd-chevron${collapsed ? "" : " open"}`}>▸</span>
            <span className="pd-folder-icon">{collapsed ? "📁" : "📂"}</span>
            <strong>{folder.name}</strong>
            <span className="pd-count">{children.length + subfolders.length}</span>
          </button>
          <div className="pd-row-actions">
            <button type="button" className="pd-icon-button" onClick={() => createRequest(folder.id)} title={tr("在此文件夹新建请求", "New request in folder")}>+</button>
            <button type="button" className={`pd-icon-button${hasScripts ? " has-dot" : ""}`} onClick={() => setFolderModalId(folder.id)} title={tr("文件夹设置与脚本", "Folder settings & scripts")}>⚙</button>
            <button type="button" className="pd-icon-button danger" onClick={() => deleteFolder(folder)} title={tr("删除文件夹", "Delete folder")}>×</button>
          </div>
        </div>
        {!collapsed && (
          <div className="pd-folder-children">
            {children.length === 0 && subfolders.length === 0 && <div className="pd-tree-empty">{tr("空文件夹", "Empty folder")}</div>}
            {subfolders.map(child => renderFolder(child, nextTrail))}
            {children.map(request => renderRequest(request))}
          </div>
        )}
      </div>
    );
  }

  function renderRequest(request) {
    const dropPos = dropTarget?.kind === "request" && dropTarget.id === request.id ? dropTarget.pos : "";
    return (
      <RequestItem
        key={request.id}
        request={request}
        selected={draft?.id === request.id}
        running={runningIds.has(request.id)}
        dragging={dragging?.id === request.id}
        dropPos={dropPos}
        draggable={!searchText}
        onSelect={selectRequest}
        onDuplicate={req => createRequest(req.folderId, req)}
        onDelete={deleteRequest}
        onDragStart={e => startDrag(e, "request", request.id)}
        onDragEnd={endDrag}
        onDragOver={e => hoverDrop(e, "request", request.id)}
        onDrop={e => dropOn(e, "request", request.id)}
      />
    );
  }

  return (
    <div className="pd-page" style={{ "--pd-sidebar-width": `${sidebarWidth}px` }}>
      <aside className="pd-sidebar">
        <div className="pd-brand">
          <span className="pd-brand-logo">🐶</span>
          <strong>Postdog</strong>
          <SaveStatus status={autosave.status} />
        </div>
        <div className="pd-mode-switch">
          <RadioGroup aria-label={tr("侧栏", "Sidebar")} variant="segmented" size="sm" value={sidebarMode} onChange={changeSidebarMode}>
            <Radio value="requests">{tr("请求", "Requests")}</Radio>
            <Radio value="flows">{tr("编排", "Flows")}{flows.length ? ` (${flows.length})` : ""}</Radio>
          </RadioGroup>
        </div>
        {sidebarMode === "flows" ? (
          <>
            <div className="pd-side-actions">
              <UiButton variant="primary" onClick={createFlow}>+ {tr("编排", "Flow")}</UiButton>
            </div>
            <div className="pd-tree">
              {flows.map(flow => (
                <div
                  key={flow.id}
                  className={`pd-request-item pd-flow-item${selectedFlowId === flow.id ? " selected" : ""}`}
                  onClick={() => setSelectedFlowId(flow.id)}
                  title={flow.name}
                >
                  <span className="pd-flow-item-icon">⇶</span>
                  <span className="pd-request-name">{flow.name || "Untitled"}</span>
                  {flowRunning && liveRun?.flowId === flow.id && <span className="pd-running-dot" />}
                  <span className="pd-count">{flow.steps.length}</span>
                </div>
              ))}
              {loaded && flows.length === 0 && (
                <div className="pd-tree-empty">{tr("还没有编排，点击上方「+ 编排」按顺序串起多个请求", "No flows yet. Click \"+ Flow\" to chain requests in order.")}</div>
              )}
            </div>
          </>
        ) : (
        <>
        <div className="pd-side-actions">
          <UiButton variant="primary" onClick={() => createRequest(draft?.folderId || null)}>+ {tr("请求", "Request")}</UiButton>
          <UiButton variant="neutral" onClick={createFolder}>+ {tr("文件夹", "Folder")}</UiButton>
          <UiButton variant="neutral" onClick={() => setCurlModalOpen(true)}>{tr("导入 curl", "Import curl")}</UiButton>
        </div>
        <div className="pd-search">
          <UiInput value={search} onChange={setSearch} placeholder={tr("搜索名称 / URL", "Search name / URL")} />
          {search && <button type="button" className="pd-icon-button" onClick={() => setSearch("")}>×</button>}
        </div>
        <div
          className={`pd-tree${dropTarget?.kind === "root" ? " drop-root" : ""}`}
          onDragOver={e => { if (e.target === e.currentTarget) hoverDrop(e, "root", "root"); }}
          onDrop={e => { if (e.target === e.currentTarget) dropOn(e, "root", "root"); }}
        >
          {tree.visibleFolders.map(folder => renderFolder(folder))}
          {tree.loose.map(request => renderRequest(request))}
          {loaded && requests.length === 0 && folders.length === 0 && (
            <div className="pd-tree-empty">{tr("还没有请求，点击上方「+ 请求」开始", "No requests yet. Click \"+ Request\" to start.")}</div>
          )}
          {searchText && tree.loose.length === 0 && tree.visibleFolders.length === 0 && (
            <div className="pd-tree-empty">{tr("没有匹配的请求", "No matching requests")}</div>
          )}
        </div>
        </>
        )}
        <div className="pd-side-footer">
          <button type="button" className="pd-link-button" onClick={() => importFileRef.current?.click()}>{tr("导入 JSON", "Import JSON")}</button>
          <button type="button" className="pd-link-button" onClick={exportJson}>{tr("导出 JSON", "Export JSON")}</button>
          <input ref={importFileRef} type="file" accept="application/json,.json" hidden onChange={e => importJsonFile(e.target.files?.[0])} />
        </div>
      </aside>
      <div className="pd-sidebar-resizer" role="separator" aria-orientation="vertical" title={tr("拖拽调整宽度，双击恢复默认", "Drag to resize, double-click to reset")} onMouseDown={startSidebarResize} onDoubleClick={resetSidebarWidth} />

      <main className="pd-main">
        <header className="pd-topbar">
          {sidebarMode === "flows" ? (
            selectedFlow ? (
              <div className="pd-title-group">
                <UiInput
                  className="pd-name-input"
                  size="sm"
                  value={selectedFlow.name}
                  onChange={name => updateFlow({ ...selectedFlow, name })}
                  placeholder={tr("编排名称", "Flow name")}
                />
              </div>
            ) : <div className="pd-title-group" />
          ) : draft ? (
            <div className="pd-title-group">
              <UiInput
                className="pd-name-input"
                size="sm"
                value={draft.name}
                onChange={name => updateDraft({ name })}
                placeholder={tr("请求名称", "Request name")}
              />
              <UiSelect
                className="pd-folder-select"
                size="sm"
                ariaLabel={tr("所属文件夹", "Folder")}
                value={draft.folderId || ""}
                options={[{ value: "", label: tr("（无文件夹）", "(no folder)") }, ...folderOptions]}
                onChange={value => updateDraft({ folderId: value || null })}
              />
            </div>
          ) : <div className="pd-title-group" />}
          <div className="pd-env-group">
            <span className="pd-env-label">{tr("环境", "Env")}</span>
            <UiSelect
              className="pd-env-select"
              size="sm"
              ariaLabel={tr("环境", "Environment")}
              value={activeEnvironmentId}
              options={[{ value: "", label: tr("无环境", "No environment") }, ...environments.map(env => ({ value: env.id, label: env.name }))]}
              onChange={switchEnvironment}
            />
            <UiButton size="sm" variant="neutral" onClick={() => setEnvModalOpen(true)} title={tr("管理环境变量", "Manage environment variables")}>
              {tr("变量", "Variables")}{activeEnvironment ? ` (${activeEnvironment.variables.length})` : ""}
            </UiButton>
          </div>
        </header>

        {sidebarMode === "flows" ? (
          selectedFlow ? (
            <FlowPanel
              key={selectedFlow.id}
              flow={selectedFlow}
              requests={requests}
              folders={folders}
              folderOptions={folderOptions}
              run={shownFlowRun}
              runs={flowRuns}
              runsLoading={flowRunsLoading}
              running={(flowRunning && liveRun?.flowId === selectedFlow.id) || !!backgroundFlowRun}
              onChange={updateFlow}
              onDelete={() => deleteFlow(selectedFlow)}
              onRun={runSelectedFlow}
              onStop={stopFlow}
              onSelectRun={setSelectedFlowRunId}
              onOpenRequest={openRequestFromFlow}
              renderRequestResult={(result, key) => <StepResponseView key={key} result={result} />}
            />
          ) : (
            <div className="pd-empty-state">
              <div className="pd-empty-icon">⇶</div>
              <div>{tr("编排：按顺序运行多个请求，脚本抛出异常即停止", "Flows run several requests in order and stop when a script throws")}</div>
              {loaded && (
                <div className="pd-empty-actions">
                  <UiButton variant="primary" onClick={createFlow}>+ {tr("新建编排", "New flow")}</UiButton>
                </div>
              )}
            </div>
          )
        ) : !draft ? (
          <div className="pd-empty-state">
            <div className="pd-empty-icon">🐶</div>
            <div>
              {!loaded ? tr("加载中...", "Loading...")
                : loadError ? `${tr("加载失败", "Failed to load")}: ${loadError}`
                : tr("选择左侧的请求，或新建一个", "Pick a request on the left, or create one")}
            </div>
            {loaded && loadError && (
              <div className="pd-empty-actions">
                <UiButton variant="primary" onClick={() => loadAll({ initial: true })}>{tr("重试", "Retry")}</UiButton>
              </div>
            )}
            {loaded && !loadError && (
              <div className="pd-empty-actions">
                <UiButton variant="primary" onClick={() => createRequest(null)}>+ {tr("新建请求", "New request")}</UiButton>
                <UiButton variant="neutral" onClick={() => setCurlModalOpen(true)}>{tr("导入 curl", "Import curl")}</UiButton>
              </div>
            )}
          </div>
        ) : (
          <>
            <section className="pd-urlbar">
              <div className="pd-url-group">
                <UiSelect
                  className={`pd-method-select method-${draft.method}`}
                  ariaLabel="Method"
                  value={draft.method}
                  options={METHODS.map(method => ({ value: method, label: method }))}
                  onChange={method => updateDraft({ method })}
                />
                <input
                  ref={urlInputRef}
                  className="pd-url-input"
                  value={draft.url}
                  onChange={e => updateDraft({ url: e.target.value })}
                  onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void runRequest(); } }}
                  placeholder="https://api.example.com/items/{{objId}}"
                  spellCheck={false}
                />
              </div>
              <UiButton size="md" variant="primary" onClick={runRequest} disabled={running} title="Ctrl/⌘ + Enter">
                {running ? tr("发送中…", "Sending…") : tr("发送", "Send")}
              </UiButton>
              <UiButton size="md" variant="neutral" onClick={exportCurrentCurl} title={tr("复制为 curl（会代入当前环境变量）", "Copy as curl (with environment variables applied)")}>
                {tr("复制 curl", "Copy curl")}
              </UiButton>
              <button type="button" className="pd-icon-button danger pd-delete-request" onClick={() => deleteRequest(draft)} title={tr("删除当前请求", "Delete this request")}>🗑</button>
            </section>
            {urlPreview && (
              <div className="pd-url-preview" title={tr("代入环境变量后的实际 URL", "Resolved URL with environment variables")}>
                <span className="pd-url-preview-arrow">→</span>
                {urlPreview.map((part, index) => (
                  <span key={index} className={part.kind === "missing" ? "missing" : part.kind === "var" ? "var" : ""} title={part.kind === "missing" ? tr(`变量 ${part.name} 未定义`, `Variable ${part.name} is not defined`) : undefined}>
                    {part.text}
                  </span>
                ))}
              </div>
            )}

            <div className="pd-split" ref={splitRef} style={{ "--pd-split": `${(splitRatio * 100).toFixed(2)}%` }}>
              <section className="pd-pane pd-request-pane">
                <TabBar
                  className="pd-tabs"
                  variant="line"
                  aria-label={tr("请求", "Request")}
                  selectedKey={requestTab}
                  onChange={changeRequestTab}
                  items={[
                    { key: "params", title: "Params", count: countEnabled(draft.query) },
                    { key: "headers", title: "Headers", count: countEnabled(draft.headers) },
                    { key: "body", title: "Body", badge: bodyType !== "none" ? bodyType : undefined },
                    { key: "pre", title: "Pre Script", dot: !!draft.preScript?.trim() },
                    { key: "post", title: "Post Script", dot: !!draft.postScript?.trim() }
                  ]}
                />
                <div className="pd-pane-body">
                  {requestTab === "params" && (
                    <div className="pd-scroll">
                      <KeyValueEditor rows={draft.query} onChange={query => updateDraft({ query })} />
                      <p className="pd-help">{tr("参数会追加到 URL 上，支持 {{变量}}。", "Params are appended to the URL. {{variables}} are supported.")}</p>
                    </div>
                  )}
                  {requestTab === "headers" && (
                    <div className="pd-scroll">
                      <KeyValueEditor rows={draft.headers} onChange={headers => updateDraft({ headers })} secretToggle maskSecrets headerSuggestions keyPlaceholder="Header" />
                      <p className="pd-help">{tr("选择 Body 类型时会自动添加 / 更新 Content-Type（你手写的值不会被改）。勾选「敏感」后，该值在日志与历史记录里显示为 ***。", "Choosing a Body type adds / updates Content-Type (values you typed yourself are kept). Secret values are shown as *** in logs and history.")}</p>
                    </div>
                  )}
                  {requestTab === "body" && (
                    <div className="pd-body-editor">
                      <div className="pd-body-toolbar">
                        <RadioGroup
                          aria-label={tr("Body 类型", "Body type")}
                          variant="segmented"
                          size="sm"
                          value={bodyType}
                          onChange={type => updateBody({ type })}
                        >
                          {BODY_TYPES.map(type => <Radio key={type} value={type}>{type}</Radio>)}
                        </RadioGroup>
                        {bodyType === "json" && (
                          <>
                            {jsonBodyError
                              ? <span className="pd-json-status error" title={jsonBodyError}>✕ {tr("JSON 无效", "Invalid JSON")}</span>
                              : bodyText.trim() ? <span className="pd-json-status ok">✓ JSON</span> : null}
                            <UiButton variant="neutral" onClick={beautifyRequestJson}>{tr("格式化", "Format")}</UiButton>
                          </>
                        )}
                      </div>
                      {bodyType === "none" ? (
                        <div className="pd-empty">{tr("该请求没有 body", "This request has no body")}</div>
                      ) : bodyType === "form" ? (
                        <div className="pd-scroll"><KeyValueEditor rows={draft.body?.fields || []} onChange={fields => updateBody({ fields })} /></div>
                      ) : bodyType === "multipart" ? (
                        <div className="pd-scroll"><MultipartEditor rows={draft.body?.fields || []} onChange={fields => updateBody({ fields })} /></div>
                      ) : (
                        <CodeEditor
                          docKey={`${draft.id}:body`}
                          language={bodyType === "json" ? "json" : "text"}
                          variables={templateVars}
                          value={bodyText}
                          onChange={text => updateBody({ text })}
                          placeholder={bodyType === "json"
                            ? '{\n  // comments are removed before send\n  "request_id": "{{$uuid()}}",\n  "created_at": "{{$now()}}",\n  "name": "{{name}}"\n}'
                            : "raw text body, supports {{variables}}"}
                        />
                      )}
                    </div>
                  )}
                  {(requestTab === "pre" || requestTab === "post") && (
                    <div className="pd-script-editor">
                      <ScriptHint
                        phase={requestTab}
                        folder={currentFolder}
                        onOpenFolder={() => currentFolder && setFolderModalId(currentFolder.id)}
                      />
                      <CodeEditor
                        docKey={`${draft.id}:${requestTab}`}
                        language="javascript"
                        value={requestTab === "pre" ? draft.preScript || "" : draft.postScript || ""}
                        onChange={text => updateDraft(requestTab === "pre" ? { preScript: text } : { postScript: text })}
                        placeholder={requestTab === "pre" ? PRE_SCRIPT_PLACEHOLDER : POST_SCRIPT_PLACEHOLDER}
                      />
                    </div>
                  )}
                </div>
              </section>

              <div className="pd-split-resizer" role="separator" onMouseDown={startSplitResize} title={tr("拖拽调整大小", "Drag to resize")} />

              <section className="pd-pane pd-response-pane">
                <ResponsePane
                  response={currentResponse}
                  running={running}
                  tab={responseTab}
                  onTab={setResponseTab}
                  bodyView={bodyView}
                  onBodyView={setBodyView}
                  historyRuns={historyRuns}
                  historyLoading={historyLoading}
                  selectedHistoryRunId={selectedHistoryRunId}
                  onOpenHistory={openHistoryRun}
                />
              </section>
            </div>
          </>
        )}
      </main>

      {envModalOpen && (
        <EnvironmentModal
          environments={environments}
          activeEnvironmentId={activeEnvironmentId}
          onSwitch={switchEnvironment}
          onCreate={createEnvironment}
          onChange={updateEnvironment}
          onDelete={deleteEnvironment}
          onClose={() => { setEnvModalOpen(false); void autosave.flushAll(); }}
        />
      )}
      {folderModal && (
        <FolderModal
          folder={folderModal}
          requestCount={requests.filter(item => item.folderId === folderModal.id).length}
          onChange={updateFolder}
          onDelete={() => deleteFolder(folderModal)}
          onClose={() => { setFolderModalId(""); void autosave.flush(folderKey(folderModal.id)); }}
        />
      )}
      {curlModalOpen && (
        <CurlImportModal
          folders={folders}
          defaultFolderId={draft?.folderId || ""}
          onImport={importCurlText}
          onClose={() => setCurlModalOpen(false)}
        />
      )}
    </div>
  );
}

const PRE_SCRIPT_PLACEHOLDER = [
  "// Runs before the request is sent. `$` is a shortcut for `postdog`.",
  "$.request.headers.set({",
  "  \"X-Trace-Id\": $.uuid(),",
  "  \"X-Timestamp\": $.timestamp()",
  "});",
  "$.request.query.set(\"page\", 1);"
].join("\n");

const POST_SCRIPT_PLACEHOLDER = [
  "// Runs after the response arrives.",
  "const data = $.response.json();",
  "await $.env.set({ token: data?.token, userId: data?.user?.id });",
  "$.test(\"status is 200\", $.response.status === 200);"
].join("\n");

function SaveStatus({ status }) {
  const label = {
    saved: tr("已自动保存", "Saved"),
    pending: tr("编辑中…", "Editing…"),
    saving: tr("保存中…", "Saving…"),
    error: tr("保存失败", "Save failed")
  }[status] || "";
  return <span className={`pd-save-status ${status}`} title={tr("所有修改都会自动保存（Ctrl/⌘+S 立即保存）", "Changes save automatically (Ctrl/⌘+S to save now)")}>{label}</span>;
}

/** A stored run still marked "running" that is not the live run was cut off (page closed / reloaded). */
function markInterruptedRun(run, liveRunId) {
  if (run?.status !== "running" || run.runId === liveRunId) return run;
  if (run.source === "background") {
    // Started by the assistant / MCP in the background: trust it while it keeps saving progress
    // (or is inside a sleep step); a run silent for 5 minutes was cut off with the worker.
    const now = Date.now();
    const sleeping = (run.steps || []).some(step => step.status === "running" && Number(step.delayUntil) > now);
    if (sleeping || now - (Number(run.updatedAt) || 0) < 5 * 60 * 1000) return run;
  }
  return {
    ...run,
    status: "stopped",
    steps: (run.steps || []).map(step => step.status === "running" ? { ...step, status: "stopped" }
      : step.status === "pending" ? { ...step, status: "skipped" } : step)
  };
}

/** Folders in tree order with their depth (cycle-safe). */
function flattenFolders(folders) {
  const ids = new Set(folders.map(item => item.id));
  const children = new Map();
  const roots = [];
  for (const folder of folders) {
    if (folder.parentId && ids.has(folder.parentId)) {
      if (!children.has(folder.parentId)) children.set(folder.parentId, []);
      children.get(folder.parentId).push(folder);
    } else {
      roots.push(folder);
    }
  }
  const out = [];
  const seen = new Set();
  const walk = (folder, depth) => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    out.push({ folder, depth });
    for (const child of children.get(folder.id) || []) walk(child, depth + 1);
  };
  roots.forEach(folder => walk(folder, 0));
  return out;
}

function descendantFolderIds(folders, id) {
  const out = new Set();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop();
    for (const folder of folders) {
      if (folder.parentId === current && !out.has(folder.id)) {
        out.add(folder.id);
        queue.push(folder.id);
      }
    }
  }
  return out;
}

function dropZone(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "into";
}

function isUpperHalf(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY - rect.top < rect.height / 2;
}

function RequestItem({ request, selected, running, dragging, dropPos, draggable, onSelect, onDuplicate, onDelete, onDragStart, onDragEnd, onDragOver, onDrop }) {
  return (
    <div
      className={`pd-request-item${selected ? " selected" : ""}${dragging ? " dragging" : ""}${dropPos ? ` drop-${dropPos}` : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => onSelect(request.id)}
      title={`${request.method} ${request.url || ""}`}
    >
      <span className={`pd-method method-${request.method}`}>{shortMethod(request.method)}</span>
      <span className="pd-request-name">{request.name || "Untitled"}</span>
      {running && <span className="pd-running-dot" />}
      <div className="pd-row-actions">
        <button type="button" className="pd-icon-button" onClick={e => { e.stopPropagation(); onDuplicate(request); }} title={tr("复制请求", "Duplicate")}>⧉</button>
        <button type="button" className="pd-icon-button danger" onClick={e => { e.stopPropagation(); onDelete(request); }} title={tr("删除请求", "Delete")}>×</button>
      </div>
    </div>
  );
}

function ScriptHint({ phase, folder, onOpenFolder }) {
  const [open, setOpen] = useState(false);
  const folderScript = phase === "pre" ? folder?.preScript : folder?.postScript;
  return (
    <div className="pd-script-hint">
      <div className="pd-script-hint-row">
        <span>
          {phase === "pre"
            ? tr("发送前执行，可修改请求。", "Runs before sending; can modify the request.")
            : tr("收到响应后执行，可读取响应、写环境变量、做断言。", "Runs after the response; read it, set variables, add tests.")}
          {" "}<code>$</code> = <code>postdog</code>
        </span>
        {folder && (
          <button type="button" className="pd-link-button" onClick={onOpenFolder}>
            {folderScript?.trim()
              ? tr(`文件夹「${folder.name}」也有 ${phase === "pre" ? "Pre" : "Post"} Script`, `Folder "${folder.name}" has a ${phase === "pre" ? "pre" : "post"} script`)
              : tr(`编辑文件夹「${folder.name}」脚本`, `Edit folder "${folder.name}" scripts`)}
          </button>
        )}
        <button type="button" className="pd-link-button" onClick={() => setOpen(value => !value)}>{open ? tr("收起 API", "Hide API") : tr("API 速查", "API cheatsheet")}</button>
      </div>
      {open && <ScriptCheatsheet />}
    </div>
  );
}

function ScriptCheatsheet() {
  const rows = [
    ["$.env.get(\"k\") / $.env.has(\"k\")", tr("读环境变量", "Read a variable")],
    ["await $.env.set(\"k\", v)", tr("写入当前环境", "Write to the active environment")],
    ["await $.env.set({ a: 1, b: 2 })", tr("批量写入", "Write many at once")],
    ["await $.env.unset(\"a\", \"b\")", tr("删除变量", "Remove variables")],
    ["$.request.headers.set({ k: v, ... })", tr("批量设置 Header（也可 set(k, v)）", "Set headers (or set(k, v))")],
    ["$.request.query.set({ page: 1 })", tr("设置 Query 参数", "Set query params")],
    ["$.request.body.set({ ... })", tr("替换 body（对象自动转 JSON）", "Replace body (objects become JSON)")],
    ["$.request.url / $.request.method", tr("可读写", "Read / write")],
    ["$.response.status / .headers / .json() / .text()", tr("Post Script 中可用", "Post script only")],
    ["$.test(\"name\", bool)", tr("记录测试结果", "Record a test")],
    ["$.assert(cond, \"msg\")", tr("不满足就抛异常（编排中该步失败并停止）", "Throw when false (fails the flow step)")],
    ["$.uuid() / $.now() / $.timestamp()", tr("工具函数", "Helpers")],
    ["await $.sleep(1000)", tr("暂停指定毫秒", "Pause for N milliseconds")],
    ["console.log(...)", tr("输出到 Script Logs", "Print to Script Logs")]
  ];
  return (
    <div className="pd-cheatsheet">
      {rows.map(([code, text]) => (
        <div key={code}><code>{code}</code><span>{text}</span></div>
      ))}
      <div className="pd-cheatsheet-note">{tr("执行顺序：文件夹 Pre → 请求 Pre → 发送 → 请求 Post → 文件夹 Post", "Order: folder pre → request pre → send → request post → folder post")}</div>
    </div>
  );
}

/** Response viewer for one flow step result (no history tab). */
function StepResponseView({ result }) {
  const [tab, setTab] = useState(() => (result?.logs || []).some(log => log.level === "error") ? "logs" : "body");
  const [bodyView, setBodyView] = useState("tree");
  return (
    <ResponsePane
      response={result}
      running={false}
      tab={tab}
      onTab={setTab}
      bodyView={bodyView}
      onBodyView={setBodyView}
      showHistory={false}
    />
  );
}

function ResponsePane({ response, running, tab, onTab, bodyView, onBodyView, historyRuns = [], historyLoading = false, selectedHistoryRunId = "", onOpenHistory = () => {}, showHistory = true }) {
  const res = response?.response;
  const bodyJson = useMemo(() => {
    if (!res || res.bodyKind === "binary") return null;
    if (res.bodyJson != null) return { ok: true, value: res.bodyJson };
    if (!res.bodyText) return null;
    try {
      return { ok: true, value: parseJsonWithComments(res.bodyText) };
    } catch {
      return null;
    }
  }, [res]);
  const testEntries = Object.entries(response?.tests || {});
  const logs = response?.logs || [];
  const headerCount = Object.keys(res?.headers || {}).length;

  async function copyBody() {
    const text = bodyJson?.ok && bodyView === "raw" ? JSON.stringify(bodyJson.value, null, 2) : res?.bodyText || "";
    if (!text) {
      toast.error(tr("没有可复制的 response body", "No response body to copy"));
      return;
    }
    await copyText(text);
    toast.success(tr("response body 已复制", "Response body copied"));
  }

  function downloadFile() {
    const file = res?.download;
    if (!file?.dataBase64) {
      toast.error(tr("没有可下载的文件内容", "No file content to download"));
      return;
    }
    downloadBase64(file.fileName, file.dataBase64, file.mimeType);
  }

  return (
    <>
      <TabBar
        className="pd-tabs"
        variant="line"
        aria-label={tr("响应", "Response")}
        selectedKey={tab}
        onChange={onTab}
        items={[
          { key: "body", title: "Body" },
          { key: "headers", title: "Headers", count: headerCount },
          { key: "request", title: "Request" },
          { key: "logs", title: "Logs", count: logs.length, dot: logs.some(log => log.level === "error") },
          ...(showHistory ? [{ key: "history", title: tr("历史", "History"), count: historyRuns.length }] : [])
        ]}
        extra={res ? (
          <div className="pd-response-meta">
            <StatusBadge status={res.status}>{res.status || "ERR"} {res.statusText || ""}</StatusBadge>
            <span>{response.durationMs} ms</span>
            {Number.isFinite(Number(res.bodySizeBytes)) && <span>{formatBytes(res.bodySizeBytes)}</span>}
          </div>
        ) : undefined}
      />
      {(response?.historyCreatedAt || testEntries.length > 0) && (
        <div className="pd-response-sub">
          {response?.historyCreatedAt && <Badge variant="warning">{tr("历史记录", "From history")} · {formatDateTime(response.historyCreatedAt)}</Badge>}
          {testEntries.map(([name, passed]) => (
            <Badge key={name} variant={passed ? "success" : "danger"}>{passed ? "✓" : "✕"} {name}</Badge>
          ))}
        </div>
      )}
      <div className="pd-pane-body">
        {tab === "history" ? (
          <div className="pd-scroll">
            <HistoryList runs={historyRuns} loading={historyLoading} selectedRunId={selectedHistoryRunId} onSelect={onOpenHistory} />
          </div>
        ) : !res ? (
          <div className="pd-empty pd-response-empty">
            {running ? tr("发送中…", "Sending…") : <>{tr("点击「发送」或按", "Click Send or press")} <kbd>Ctrl</kbd>+<kbd>Enter</kbd></>}
          </div>
        ) : tab === "headers" ? (
          <div className="pd-scroll"><HeaderTable headers={res.headers || {}} emptyText={tr("无响应 Header", "No response headers")} /></div>
        ) : tab === "request" ? (
          <div className="pd-scroll pd-request-snapshot">
            <div className="pd-snapshot-line"><strong>{response.request?.method}</strong> <span>{response.request?.url}</span></div>
            <div className="pd-snapshot-meta">
              {response.request?.environment?.name && <span>{tr("环境", "Env")}: {response.request.environment.name}</span>}
              {response.request?.bodyType && <span>Body: {response.request.bodyType}</span>}
              {response.request?.sent === false && <span className="pd-not-sent">{tr("未发送（脚本或请求出错）", "Not sent (script or request error)")}</span>}
              {response.response?.url && response.response.url !== response.request?.url && <span>{tr("最终 URL", "Final URL")}: {response.response.url}</span>}
            </div>
            <div className="pd-section-title">Headers</div>
            <HeaderTable headers={response.request?.headers || {}} emptyText={tr("无请求 Header", "No request headers")} />
            <div className="pd-section-title">Body</div>
            {response.request?.body ? <pre className="pd-pre">{formatRequestBodyForDisplay(response.request.body)}</pre> : <div className="pd-empty">{tr("无 request body", "No request body")}</div>}
            {response.request?.template && (
              <details className="pd-template">
                <summary>{tr("原始模板（变量替换、脚本修改之前）", "Original template (before variables and scripts)")}</summary>
                <div className="pd-snapshot-line"><strong>{response.request.template.method}</strong> <span>{response.request.template.url}</span></div>
                <HeaderTable headers={response.request.template.headers || []} emptyText={tr("无 Header", "No headers")} />
                {(response.request.template.query || []).length > 0 && (
                  <>
                    <div className="pd-section-title">Params</div>
                    <HeaderTable headers={response.request.template.query} />
                  </>
                )}
                {response.request.template.body?.text && <pre className="pd-pre">{response.request.template.body.text}</pre>}
              </details>
            )}
          </div>
        ) : tab === "logs" ? (
          <div className="pd-scroll">
            {logs.length === 0 ? <div className="pd-empty">{tr("脚本没有输出", "No script output")}</div> : (
              <div className="pd-log-list">
                {logs.map((log, index) => (
                  <div key={index} className={`pd-log ${log.level || "info"}`}>
                    <span className="pd-log-phase">{log.phase || "script"}</span>
                    <span className="pd-log-level">{String(log.level || "info").toUpperCase()}</span>
                    <code>{log.message}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : res.bodyKind === "binary" ? (
          <div className="pd-scroll pd-file-response">
            <div>{formatBinaryResponseMessage(res)}</div>
            {res.download?.dataBase64 && <UiButton variant="primary" onClick={downloadFile}>{tr("下载文件", "Download file")}</UiButton>}
          </div>
        ) : (
          <div className="pd-response-body">
            <div className="pd-body-toolbar">
              {bodyJson?.ok && (
                <RadioGroup
                  aria-label={tr("响应视图", "Response view")}
                  variant="segmented"
                  size="sm"
                  value={bodyView}
                  onChange={onBodyView}
                >
                  <Radio value="tree">{tr("树形", "Tree")}</Radio>
                  <Radio value="raw">{tr("文本", "Raw")}</Radio>
                </RadioGroup>
              )}
              {res.bodyNote && <span className="pd-body-note">{res.bodyNote}</span>}
              <div className="pd-tabs-spacer" />
              {(res.bodyText || bodyJson?.ok) && <UiButton variant="neutral" onClick={copyBody}>{tr("复制", "Copy")}</UiButton>}
            </div>
            <div className="pd-scroll">
              {bodyJson?.ok && bodyView === "tree" ? (
                <JsonViewer value={bodyJson.value} />
              ) : bodyJson?.ok ? (
                <pre className="pd-pre">{JSON.stringify(bodyJson.value, null, 2)}</pre>
              ) : res.bodyText ? (
                <pre className="pd-pre">{res.bodyText}</pre>
              ) : (
                <pre className="pd-pre error">{res.error || res.bodyNote || tr("（空 body）", "(empty body)")}</pre>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function EnvironmentModal({ environments, activeEnvironmentId, onSwitch, onCreate, onChange, onDelete, onClose }) {
  const [selectedId, setSelectedId] = useState(activeEnvironmentId || environments[0]?.id || "");
  const selected = environments.find(item => item.id === selectedId) || environments[0] || null;

  async function create() {
    const env = await onCreate();
    if (env) setSelectedId(env.id);
  }

  return (
    <Modal title={tr("环境变量", "Environments")} onClose={onClose} width={980} className="pd-env-modal">
      <div className="pd-env-layout">
        <div className="pd-env-list">
          {environments.map(env => (
            <button key={env.id} type="button" className={`pd-env-item${selected?.id === env.id ? " selected" : ""}`} onClick={() => setSelectedId(env.id)}>
              <span className="pd-env-name">{env.name}</span>
              {env.id === activeEnvironmentId && <Badge variant="success">{tr("当前", "Active")}</Badge>}
              <span className="pd-count">{env.variables.length}</span>
            </button>
          ))}
          {environments.length === 0 && <div className="pd-tree-empty">{tr("还没有环境", "No environments yet")}</div>}
          <UiButton variant="neutral" onClick={create}>+ {tr("新建环境", "New environment")}</UiButton>
        </div>
        <div className="pd-env-detail">
          {selected ? (
            <>
              <div className="pd-env-detail-head">
                <UiInput className="pd-name-input" value={selected.name} onChange={name => onChange({ ...selected, name })} placeholder={tr("环境名称", "Environment name")} />
                {selected.id === activeEnvironmentId ? (
                  <Badge variant="success">{tr("当前环境", "Active environment")}</Badge>
                ) : (
                  <UiButton size="md" variant="primary" onClick={() => onSwitch(selected.id)}>{tr("设为当前", "Set active")}</UiButton>
                )}
                <UiButton size="md" variant="danger" onClick={() => onDelete(selected)}>{tr("删除", "Delete")}</UiButton>
              </div>
              <div className="pd-env-vars">
                <KeyValueEditor
                  key={selected.id}
                  rows={selected.variables}
                  onChange={variables => onChange({ ...selected, variables })}
                  secretToggle
                  maskSecrets
                  keyPlaceholder={tr("变量名", "name")}
                  valuePlaceholder={tr("值", "value")}
                />
              </div>
              <p className="pd-help">
                {tr("在 URL / Header / Params / Body 中用 ", "Use ")}<code>{"{{name}}"}</code>
                {tr(" 引用；脚本里用 ", " in URL / headers / params / body; in scripts use ")}<code>$.env.get(&quot;name&quot;)</code> / <code>await $.env.set(&#123; name: v &#125;)</code>
                {tr("。修改会自动保存。", ". Changes save automatically.")}
              </p>
            </>
          ) : (
            <div className="pd-empty">{tr("新建一个环境来管理变量", "Create an environment to manage variables")}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FolderModal({ folder, requestCount, onChange, onDelete, onClose }) {
  return (
    <Modal
      title={tr("文件夹设置", "Folder settings")}
      onClose={onClose}
      width={1080}
      className="pd-folder-modal"
      footer={(
        <>
          <UiButton variant="danger" onClick={onDelete}>{tr("删除文件夹", "Delete folder")}</UiButton>
          <span className="pd-help inline">{tr("修改会自动保存", "Changes save automatically")}</span>
          <UiButton variant="primary" onClick={onClose}>{tr("完成", "Done")}</UiButton>
        </>
      )}
    >
      <div className="pd-folder-form">
        <label className="pd-field">
          <span>{tr("名称", "Name")}</span>
          <UiInput className="pd-name-input" ariaLabel={tr("文件夹名称", "Folder name")} value={folder.name} onChange={name => onChange({ ...folder, name })} autoFocus />
        </label>
        <span className="pd-help inline">{tr(`包含 ${requestCount} 个请求`, `${requestCount} request(s)`)}</span>
      </div>
      <p className="pd-help">{tr("文件夹脚本对其中所有请求生效。执行顺序：文件夹 Pre → 请求 Pre → 发送 → 请求 Post → 文件夹 Post。", "Folder scripts apply to every request inside. Order: folder pre → request pre → send → request post → folder post.")}</p>
      <div className="pd-folder-scripts">
        <div className="pd-folder-script">
          <div className="pd-section-title">Pre Script</div>
          <CodeEditor
            docKey={`${folder.id}:pre`}
            language="javascript"
            value={folder.preScript || ""}
            onChange={text => onChange({ ...folder, preScript: text })}
            placeholder={'$.request.headers.set({ Authorization: "Bearer " + $.env.get("token") });'}
          />
        </div>
        <div className="pd-folder-script">
          <div className="pd-section-title">Post Script</div>
          <CodeEditor
            docKey={`${folder.id}:post`}
            language="javascript"
            value={folder.postScript || ""}
            onChange={text => onChange({ ...folder, postScript: text })}
            placeholder={'$.test("2xx", $.response.ok);\nawait $.env.set("lastStatus", $.response.status);'}
          />
        </div>
      </div>
      <ScriptCheatsheet />
    </Modal>
  );
}

function CurlImportModal({ folders, defaultFolderId, onImport, onClose }) {
  const [text, setText] = useState("");
  const [folderId, setFolderId] = useState(defaultFolderId || "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (await onImport(text, folderId)) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={tr("导入 curl", "Import curl")}
      onClose={onClose}
      width={720}
      footer={(
        <>
          <div className="pd-tabs-spacer" />
          <UiButton variant="neutral" onClick={onClose}>{tr("取消", "Cancel")}</UiButton>
          <UiButton variant="primary" onClick={submit} disabled={busy || !text.trim()}>{tr("导入", "Import")}</UiButton>
        </>
      )}
    >
      <div className="pd-field pd-curl-folder">
        <span>{tr("放入", "Into")}</span>
        <UiSelect
          ariaLabel={tr("放入文件夹", "Target folder")}
          value={folderId}
          options={[{ value: "", label: tr("（无文件夹）", "(no folder)") }, ...flattenFolders(folders).map(({ folder, depth }) => ({ value: folder.id, label: `${"  ".repeat(depth)}${folder.name}` }))]}
          onChange={setFolderId}
        />
      </div>
      <textarea
        className="pd-curl-input"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={"curl -X POST 'https://api.example.com/items' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{\"name\":\"a\"}'"}
        spellCheck={false}
        autoFocus
      />
    </Modal>
  );
}

// ------------------------------------------------------------------ helpers

function buildUrlPreview(url, query, vars) {
  const text = String(url || "");
  const enabledQuery = (query || []).filter(item => item.enabled !== false && item.key);
  if (!text.includes("{{") && !enabledQuery.some(item => `${item.key}${item.value}`.includes("{{"))) return null;
  const parts = [];
  const pushResolved = value => {
    const source = String(value ?? "");
    let last = 0;
    for (const match of source.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      if (match.index > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
      const name = match[1];
      if (/^\$/.test(name)) parts.push({ kind: "var", text: `{{${name}}}` });
      else if (Object.prototype.hasOwnProperty.call(vars, name)) parts.push({ kind: "var", text: String(vars[name]) });
      else parts.push({ kind: "missing", text: `{{${name}}}`, name });
      last = match.index + match[0].length;
    }
    if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  };
  pushResolved(text);
  enabledQuery.forEach((item, index) => {
    parts.push({ kind: "text", text: index === 0 && !text.includes("?") ? "?" : "&" });
    pushResolved(item.key);
    parts.push({ kind: "text", text: "=" });
    pushResolved(item.value);
  });
  return parts;
}

function countEnabled(rows) {
  return (rows || []).filter(item => item.enabled !== false && String(item.key || "").trim()).length;
}

function shortMethod(method) {
  const value = String(method || "GET").toUpperCase();
  return { DELETE: "DEL", OPTIONS: "OPT", PATCH: "PATCH" }[value] || value;
}

function formatBinaryResponseMessage(response) {
  const contentType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "unknown";
  return `${response.bodyNote || tr("二进制响应未展示。", "Binary response not shown.")} Content-Type: ${contentType}; Size: ${formatBytes(response.bodySizeBytes)}`;
}

function formatRequestBodyForDisplay(body) {
  if (typeof body === "string") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  if (body == null) return "";
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function readLocal(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function readJsonLocal(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
}

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(0.8, Math.max(0.2, number));
}

function sendPostdog(action, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "postdog_manager", action, payload }, response => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { success: false, error: "empty response" });
    });
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function downloadText(fileName, text, mimeType) {
  downloadBlob(fileName, new Blob([text], { type: mimeType }));
}

function downloadBase64(fileName, dataBase64, mimeType) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  downloadBlob(fileName || "download", new Blob([bytes], { type: mimeType || "application/octet-stream" }));
}

function downloadBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatDate(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
