/* global chrome */
/* eslint-disable react/prop-types, react-hooks/exhaustive-deps */
import { Button } from "@sunwu51/camel-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  POSTDOG_ACTIVE_ENVIRONMENT_KEY,
  POSTDOG_ENVIRONMENTS_KEY,
  POSTDOG_FOLDERS_KEY,
  POSTDOG_HISTORY_KEY,
  POSTDOG_REQUESTS_KEY
} from "../../api/postdog";
import { formatJsonWithComments, parseJsonWithComments } from "../../api/postdog/json";
import JsonCodeEditor from "./JsonCodeEditor";
import "./postdog.css";

const EMPTY_REQUEST = {
  name: "New Request",
  method: "GET",
  url: "",
  folderId: null,
  headers: [],
  query: [],
  body: { type: "none", text: "", fields: [] },
  preScript: "",
  postScript: ""
};
const SIDEBAR_WIDTH_KEY = "postdogSidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 230;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 520;
const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;

export default function PostdogPanel() {
  const [folders, setFolders] = useState([]);
  const [requests, setRequests] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [activeEnvironmentId, setActiveEnvironmentId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(EMPTY_REQUEST);
  const [response, setResponse] = useState(null);
  const [running, setRunning] = useState(false);
  const [envDraft, setEnvDraft] = useState(null);
  const [importText, setImportText] = useState("");
  const [responseTab, setResponseTab] = useState("body");
  const [requestTab, setRequestTab] = useState("headers");
  const [envExpanded, setEnvExpanded] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());
  const [historyRuns, setHistoryRuns] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => readSavedSidebarWidth());
  const importFileRef = useRef(null);
  const sidebarDragRef = useRef(null);
  const knownFolderIdsRef = useRef(new Set());
  const foldersInitializedRef = useRef(false);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    function handleStorageChange(changes, areaName) {
      if (areaName !== "local") return;
      if (
        changes[POSTDOG_FOLDERS_KEY] ||
        changes[POSTDOG_REQUESTS_KEY] ||
        changes[POSTDOG_ENVIRONMENTS_KEY] ||
        changes[POSTDOG_ACTIVE_ENVIRONMENT_KEY] ||
        changes[POSTDOG_HISTORY_KEY]
      ) {
        void loadAll();
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  useEffect(() => () => {
    document.body.classList.remove("postdog-resizing-sidebar");
    window.removeEventListener("mousemove", resizeSidebar);
    window.removeEventListener("mouseup", stopSidebarResize);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDraft(EMPTY_REQUEST);
      return;
    }
    const selected = requests.find(item => item.id === selectedId);
    if (selected) {
      setDraft(clone(selected));
    }
  }, [selectedId, requests]);

  useEffect(() => {
    const env = environments.find(item => item.id === activeEnvironmentId) || environments[0] || null;
    setEnvDraft(env ? clone(env) : null);
  }, [activeEnvironmentId, environments]);

  useEffect(() => {
    void loadHistoryForRequest(draft.id || selectedId);
  }, [draft.id, selectedId]);

  const grouped = useMemo(() => {
    const byFolder = new Map();
    for (const folder of folders) byFolder.set(folder.id, []);
    const loose = [];
    for (const request of requests) {
      if (request.folderId && byFolder.has(request.folderId)) byFolder.get(request.folderId).push(request);
      else loose.push(request);
    }
    return { byFolder, loose };
  }, [folders, requests]);

  function startSidebarResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    sidebarDragRef.current = { startX, startWidth, currentWidth: startWidth };
    document.body.classList.add("postdog-resizing-sidebar");
    window.addEventListener("mousemove", resizeSidebar);
    window.addEventListener("mouseup", stopSidebarResize);
  }

  function resizeSidebar(event) {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    const next = clamp(drag.startWidth + event.clientX - drag.startX, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    drag.currentWidth = next;
    setSidebarWidth(next);
  }

  function stopSidebarResize() {
    const next = sidebarDragRef.current?.currentWidth;
    if (next) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    sidebarDragRef.current = null;
    document.body.classList.remove("postdog-resizing-sidebar");
    window.removeEventListener("mousemove", resizeSidebar);
    window.removeEventListener("mouseup", stopSidebarResize);
  }

  async function loadAll() {
    const res = await sendPostdog("list_all");
    if (!res?.success) {
      toast.error(res?.error || "加载 Postdog 失败");
      return;
    }
    const nextFolders = res.data.folders || [];
    const nextFolderIds = new Set(nextFolders.map(folder => folder.id));
    setFolders(nextFolders);
    setCollapsedFolders(prev => {
      if (!foldersInitializedRef.current) {
        foldersInitializedRef.current = true;
        return nextFolderIds;
      }
      const next = new Set([...prev].filter(id => nextFolderIds.has(id)));
      return next;
    });
    knownFolderIdsRef.current = nextFolderIds;
    setRequests(res.data.requests || []);
    setEnvironments(res.data.environments || []);
    setActiveEnvironmentId(res.data.activeEnvironmentId || "");
    if (!selectedId && res.data.requests?.[0]?.id) setSelectedId(res.data.requests[0].id);
  }

  async function createFolder() {
    const name = window.prompt("文件夹名称", "API");
    if (!name) return;
    const res = await sendPostdog("save_folder", { folder: { name } });
    if (res?.success) {
      toast.success("文件夹已创建");
      await loadAll();
    } else {
      toast.error(res?.error || "创建失败");
    }
  }

  async function saveFolderScript(folder, patch) {
    const res = await sendPostdog("save_folder", { folder: { ...folder, ...patch } });
    if (res?.success) {
      setFolders(prev => prev.map(item => item.id === res.data.id ? res.data : item));
      toast.success("文件夹脚本已保存");
    } else {
      toast.error(res?.error || "保存文件夹脚本失败");
    }
  }

  async function deleteFolder(folder) {
    if (!folder?.id || !window.confirm(`删除文件夹「${folder.name}」以及里面的所有请求？`)) return;
    const res = await sendPostdog("delete_folder", { id: folder.id });
    if (res?.success) {
      if (draft.folderId === folder.id) {
        setSelectedId("");
        setResponse(null);
        setSelectedHistoryRunId("");
      }
      toast.success(`文件夹已删除${res.data?.removedRequests ? `，同时删除 ${res.data.removedRequests} 个请求` : ""}`);
      await loadAll();
    } else {
      toast.error(res?.error || "删除文件夹失败");
    }
  }

  async function createRequest(folderId = null) {
    const request = { ...EMPTY_REQUEST, folderId, name: "New Request" };
    const res = await sendPostdog("save_request", { request });
    if (res?.success) {
      setResponse(null);
      setSelectedHistoryRunId("");
      setSelectedId(res.data.id);
      toast.success("请求已创建");
      await loadAll();
    } else {
      toast.error(res?.error || "创建失败");
    }
  }

  async function saveRequest() {
    const res = await sendPostdog("save_request", { request: draft });
    if (res?.success) {
      setSelectedId(res.data.id);
      toast.success("请求已保存");
      await loadAll();
    } else {
      toast.error(res?.error || "保存失败");
    }
  }

  async function runRequest() {
    setRunning(true);
    try {
      const saved = await sendPostdog("save_request", { request: draft });
      if (!saved?.success) {
        toast.error(saved?.error || "保存失败");
        return;
      }
      setSelectedId(saved.data.id);
      const res = await sendPostdog("run_request", { id: saved.data.id });
      if (res?.success) {
        setResponse(res.data);
        setResponseTab("body");
        setSelectedHistoryRunId(res.data.runId || "");
        toast.success(`完成 ${res.data.response?.status || ""}`);
        await loadAll();
        await loadHistoryForRequest(saved.data.id);
      } else {
        toast.error(res?.error || "执行失败");
      }
    } finally {
      setRunning(false);
    }
  }

  async function deleteRequest() {
    if (!draft.id || !window.confirm(`删除请求「${draft.name}」？`)) return;
    const res = await sendPostdog("delete_request", { id: draft.id });
    if (res?.success) {
      toast.success("请求已删除");
      setSelectedId("");
      setResponse(null);
      setSelectedHistoryRunId("");
      await loadAll();
    } else {
      toast.error(res?.error || "删除失败");
    }
  }

  function toggleFolder(folderId) {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function selectRequest(id) {
    setResponse(null);
    setSelectedHistoryRunId("");
    setSelectedId(id);
  }

  async function loadHistoryForRequest(requestId) {
    const id = String(requestId || "").trim();
    if (!id) {
      setHistoryRuns([]);
      setSelectedHistoryRunId("");
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await sendPostdog("list_history", { requestId: id });
      if (res?.success) setHistoryRuns(res.data || []);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openHistoryRun(runId) {
    const res = await sendPostdog("get_history_run", { runId });
    if (!res?.success || !res.data) {
      toast.error(res?.error || "历史记录不存在");
      return;
    }
    setSelectedHistoryRunId(runId);
    setResponse({
      runId: res.data.runId || res.data.id,
      request: res.data.request,
      response: res.data.response,
      durationMs: res.data.durationMs,
      tests: res.data.tests || {},
      logs: res.data.logs || [],
      historyCreatedAt: res.data.createdAt
    });
    setResponseTab("body");
  }

  async function createEnvironment() {
    const name = window.prompt("环境名称", "local");
    if (!name) return;
    const res = await sendPostdog("save_environment", { environment: { name, variables: [] } });
    if (res?.success) {
      setActiveEnvironmentId(res.data.id);
      await sendPostdog("set_active_environment", { id: res.data.id });
      toast.success("环境已创建");
      await loadAll();
    } else {
      toast.error(res?.error || "创建环境失败");
    }
  }

  async function saveEnvironment() {
    if (!envDraft) return;
    const res = await sendPostdog("save_environment", { environment: envDraft });
    if (res?.success) {
      toast.success("环境已保存");
      await loadAll();
    } else {
      toast.error(res?.error || "保存环境失败");
    }
  }

  async function switchEnvironment(id) {
    setActiveEnvironmentId(id);
    await sendPostdog("set_active_environment", { id });
  }

  async function importCurlText() {
    if (!importText.trim()) return;
    const res = await sendPostdog("import_curl", { text: importText, folderId: draft.folderId });
    if (res?.success) {
      setSelectedId(res.data.id);
      setImportText("");
      toast.success("curl 已导入");
      await loadAll();
    } else {
      toast.error(res?.error || "导入失败");
    }
  }

  async function exportCurrentCurl() {
    const res = await sendPostdog("export_curl", { request: draft });
    if (!res?.success) {
      toast.error(res?.error || "复制失败");
      return;
    }
    await copyText(res.data.text);
    toast.success("curl 已复制");
  }

  async function copyResponseBody() {
    const text = response?.response?.bodyText || "";
    if (!text) {
      toast.error("没有可复制的 response body");
      return;
    }
    await copyText(text);
    toast.success("response body 已复制");
  }

  const requestBodyJson = useMemo(() => {
    if (draft.body?.type !== "json" || !draft.body?.text?.trim()) return null;
    return parseJsonForView(draft.body.text);
  }, [draft.body?.type, draft.body?.text]);

  const responseBodyJson = useMemo(() => {
    if (!response?.response) return null;
    if (response.response.bodyKind === "binary") return null;
    if (response.response.bodyJson != null) return { ok: true, value: response.response.bodyJson };
    if (!response.response.bodyText) return null;
    return parseJsonForView(response.response.bodyText);
  }, [response]);

  const responseStatusClass = getStatusClass(response?.response?.status);
  const requestBodyType = draft.body?.type || "none";
  const requestBodyText = draft.body?.text || "";

  async function exportJson() {
    const res = await sendPostdog("export_json");
    if (res?.success) downloadText(`postdog-${formatDate(new Date())}.json`, res.data.text, "application/json;charset=utf-8");
    else toast.error(res?.error || "导出失败");
  }

  async function importJsonFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const res = await sendPostdog("import_json", { text });
      if (!res?.success) throw new Error(res?.error || "导入失败");
      toast.success("Postdog JSON 已导入");
      await loadAll();
    } catch (error) {
      toast.error(error?.message || "导入失败");
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  }

  function downloadResponseFile() {
    const file = response?.response?.download;
    if (!file?.dataBase64) {
      toast.error("没有可下载的文件内容");
      return;
    }
    downloadBase64(file.fileName, file.dataBase64, file.mimeType);
  }

  function beautifyRequestJson() {
    try {
      setDraft({ ...draft, body: { ...draft.body, text: formatJsonWithComments(requestBodyText, 2) } });
    } catch (error) {
      toast.error(error?.message || "JSON 格式错误");
    }
  }

  return (
    <div className="postdog-page" style={{ "--postdog-sidebar-width": `${sidebarWidth}px` }}>
      <aside className="postdog-sidebar">
        <div className="postdog-toolbar">
          <Button className="!min-h-7 !px-2 !text-xs" onPress={() => createRequest(null)}>新增请求</Button>
          <Button className="!min-h-7 !px-2 !text-xs" onPress={createFolder}>新增文件夹</Button>
          <Button className="!min-h-7 !px-2 !text-xs" onPress={exportJson}>导出 JSON</Button>
          <Button className="!min-h-7 !px-2 !text-xs" onPress={() => importFileRef.current?.click()}>导入 JSON</Button>
          <input ref={importFileRef} type="file" accept="application/json,.json" hidden onChange={e => importJsonFile(e.target.files?.[0])} />
        </div>
        {!selectedId && <RequestButton request={null} selected onPress={() => selectRequest("")} label="未保存草稿" />}
        {folders.map(folder => (
          <div key={folder.id} className="postdog-folder">
            <div className="postdog-folder-title">
              <button type="button" className="postdog-folder-toggle" onClick={() => toggleFolder(folder.id)}>
                <span>{collapsedFolders.has(folder.id) ? ">" : "v"}</span>
                <strong>{folder.name}</strong>
              </button>
              <button type="button" className="postdog-folder-add" onClick={() => createRequest(folder.id)}>+</button>
              <button type="button" className="postdog-folder-delete" onClick={() => deleteFolder(folder)} title="删除文件夹">×</button>
            </div>
            {!collapsedFolders.has(folder.id) && (
              <div className="postdog-folder-children">
                <FolderScriptEditor folder={folder} onSave={saveFolderScript} />
                {(grouped.byFolder.get(folder.id) || []).map(request => (
                  <RequestButton key={request.id} request={request} selected={selectedId === request.id} onPress={() => selectRequest(request.id)} />
                ))}
              </div>
            )}
          </div>
        ))}
        {grouped.loose.map(request => (
          <RequestButton key={request.id} request={request} selected={selectedId === request.id} onPress={() => selectRequest(request.id)} />
        ))}
      </aside>
      <div
        className="postdog-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整请求列表宽度"
        title="拖拽调整请求列表宽度"
        onMouseDown={startSidebarResize}
      />

      <main className="postdog-main">
        <section className="postdog-meta-bar">
          <div className="postdog-field">
            <label>名称</label>
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="postdog-field">
            <label>文件夹</label>
            <select value={draft.folderId || ""} onChange={e => setDraft({ ...draft, folderId: e.target.value || null })}>
              <option value="">无</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </div>
        </section>

        <section className="postdog-request-bar">
          <select className="postdog-method-select" value={draft.method} onChange={e => setDraft({ ...draft, method: e.target.value })}>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map(method => <option key={method}>{method}</option>)}
          </select>
          <input className="postdog-url-input" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="https://api.example.com/items/{{objId}}" />
          <Button className="!min-h-8 !px-3 !text-xs" onPress={runRequest} isDisabled={running}>{running ? "发送中" : "发送"}</Button>
          <Button className="!min-h-8 !px-3 !text-xs" onPress={saveRequest}>保存</Button>
        </section>

        <section className="postdog-grid">
          <div className="postdog-workspace">
            <div className="postdog-editor">
              <div className="postdog-tab-buttons postdog-request-tabs">
                <button type="button" className={requestTab === "headers" ? "active" : ""} onClick={() => setRequestTab("headers")}>Headers</button>
                <button type="button" className={requestTab === "body" ? "active" : ""} onClick={() => setRequestTab("body")}>Body</button>
                <button type="button" className={requestTab === "query" ? "active" : ""} onClick={() => setRequestTab("query")}>Params</button>
              </div>
              {requestTab === "headers" ? (
                <KeyValueEditor rows={draft.headers} onChange={headers => setDraft({ ...draft, headers })} secretToggle />
              ) : requestTab === "query" ? (
                <KeyValueEditor rows={draft.query} onChange={query => setDraft({ ...draft, query })} />
              ) : (
                <div className="postdog-body-editor">
                  <div className="postdog-body-toolbar">
                    <select value={requestBodyType} onChange={e => setDraft({ ...draft, body: { ...draft.body, type: e.target.value } })}>
                      <option value="none">none</option>
                      <option value="json">json</option>
                      <option value="text">text</option>
                      <option value="form">form</option>
                      <option value="multipart">multipart</option>
                    </select>
                    {requestBodyType === "json" && (
                      <Button className="postdog-beautify-button !min-h-7 !px-2 !text-xs" onPress={beautifyRequestJson}>格式化 JSON</Button>
                    )}
                  </div>
                  {requestBodyType === "form" ? (
                    <KeyValueEditor
                      rows={draft.body?.fields || []}
                      onChange={fields => setDraft({ ...draft, body: { ...draft.body, fields } })}
                    />
                  ) : requestBodyType === "multipart" ? (
                    <MultipartEditor
                      rows={draft.body?.fields || []}
                      onChange={fields => setDraft({ ...draft, body: { ...draft.body, fields } })}
                    />
                  ) : requestBodyType === "json" ? (
                    <JsonCodeEditor
                      value={requestBodyText}
                      onChange={text => setDraft({ ...draft, body: { ...draft.body, text } })}
                      placeholder={'{\n  // comments are removed before send\n  "request_id": "{{$uuid()}}",\n  "created_at": "{{$now()}}",\n  "name": "{{name}}"\n}'}
                    />
                  ) : (
                    <textarea
                      wrap="off"
                      spellCheck={false}
                      value={requestBodyText}
                      onChange={e => setDraft({ ...draft, body: { ...draft.body, text: e.target.value } })}
                      placeholder={'{\n  "request_id": "{{$uuid()}}",\n  "created_at": "{{$now()}}",\n  "name": "{{name}}"\n}'}
                    />
                  )}
                  {requestBodyJson && (
                    <div className="postdog-json-preview">
                      <div className="postdog-json-preview-title">Body JSON Preview</div>
                      {requestBodyJson.ok ? <JsonViewer value={requestBodyJson.value} /> : <pre>{requestBodyJson.error}</pre>}
                    </div>
                  )}
                </div>
              )}
              <details className="postdog-script-section">
                <summary>Pre Script</summary>
                <textarea wrap="off" spellCheck={false} value={draft.preScript || ""} onChange={e => setDraft({ ...draft, preScript: e.target.value })} placeholder='postdog.request.headers.set("X-Trace", Date.now())' />
              </details>
              <details className="postdog-script-section">
                <summary>Post Script</summary>
                <textarea wrap="off" spellCheck={false} value={draft.postScript || ""} onChange={e => setDraft({ ...draft, postScript: e.target.value })} placeholder='postdog.env.set("objId", postdog.response.json()?.id)' />
              </details>
            </div>

            <div className="postdog-card postdog-response">
              <div className="postdog-response-header">
                <div>
                  <div className="postdog-card-title">响应</div>
                  {response?.historyCreatedAt && <div className="postdog-run-id">历史: {formatDateTime(response.historyCreatedAt)}</div>}
                  {response?.runId && <div className="postdog-run-id">runId: {response.runId}</div>}
                </div>
                {response?.response ? (
                  <div className="postdog-response-meta">
                    <span className={`postdog-status ${responseStatusClass}`}>{response.response.status || 0}</span>
                    <span>{response.durationMs}ms</span>
                  </div>
                ) : null}
              </div>
              {response?.tests && Object.keys(response.tests).length > 0 && (
                <div className="postdog-tests">
                  {Object.entries(response.tests).map(([name, passed]) => (
                    <span key={name} className={passed ? "postdog-pass" : "postdog-fail"}>{passed ? "PASS" : "FAIL"} {name}</span>
                  ))}
                </div>
              )}
              {response?.logs?.length > 0 && (
                <details className="postdog-script-logs" open>
                  <summary>Script Logs</summary>
                  <div className="postdog-script-log-list">
                    {response.logs.map((log, index) => (
                      <div key={index} className={`postdog-script-log ${log.level || "info"}`}>
                        <span>{log.phase || "script"}</span>
                        <strong>{String(log.level || "info").toUpperCase()}</strong>
                        <code>{log.message}</code>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {response?.request && (
                <details className="postdog-request-snapshot" open>
                  <summary>Request</summary>
                  <div className="postdog-request-snapshot-line">
                    <strong>{response.request.method}</strong>
                    <span>{response.request.url}</span>
                  </div>
                  {response.request.body ? (
                    <pre>{formatRequestBodyForDisplay(response.request.body)}</pre>
                  ) : (
                    <div className="postdog-empty-response">无 request body</div>
                  )}
                </details>
              )}
              <div className="postdog-tabs">
                <div className="postdog-tab-buttons">
                  <button type="button" className={responseTab === "body" ? "active" : ""} onClick={() => setResponseTab("body")}>Body</button>
                  <button type="button" className={responseTab === "headers" ? "active" : ""} onClick={() => setResponseTab("headers")}>Headers</button>
                </div>
                {responseTab === "body" && response?.response?.bodyText ? (
                  <button type="button" className="postdog-copy-body-button" onClick={copyResponseBody}>复制 body</button>
                ) : null}
              </div>
              <div className="postdog-response-content">
                {!response?.response ? (
                  <div className="postdog-empty-response">尚未发送请求</div>
                ) : responseTab === "headers" ? (
                  <HeaderTable headers={response.response.headers || {}} />
                ) : response.response.bodyKind === "binary" ? (
                  <div className="postdog-file-response">
                    <div>{formatBinaryResponseMessage(response.response)}</div>
                    {response.response.download?.dataBase64 && (
                      <Button className="!min-h-7 !px-2 !text-xs" onPress={downloadResponseFile}>下载文件</Button>
                    )}
                  </div>
                ) : responseBodyJson?.ok ? (
                  <>
                    {response.response.bodyNote && <div className="postdog-body-note">{response.response.bodyNote}</div>}
                    <JsonViewer value={responseBodyJson.value} />
                  </>
                ) : response.response.bodyText ? (
                  <>
                    {response.response.bodyNote && <div className="postdog-body-note">{response.response.bodyNote}</div>}
                    <pre>{response.response.bodyText}</pre>
                  </>
                ) : (
                  <pre>{response.response.error || response.response.bodyNote || ""}</pre>
                )}
              </div>
            </div>
          </div>

          <div className="postdog-sidepanel">
            <div className="postdog-card">
              <div className="postdog-card-title">环境变量</div>
              <div className="postdog-row">
                <select value={activeEnvironmentId} onChange={e => switchEnvironment(e.target.value)}>
                  <option value="">无环境</option>
                  {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                </select>
                <Button className="postdog-env-add-button !min-h-7 !px-2 !text-xs" onPress={createEnvironment}>新增</Button>
                <Button className="postdog-env-toggle-button !min-h-7 !px-2 !text-xs" onPress={() => setEnvExpanded(expanded => !expanded)}>{envExpanded ? "收起" : "展开"}</Button>
              </div>
              {envDraft && envExpanded && (
                <>
                  <input value={envDraft.name} onChange={e => setEnvDraft({ ...envDraft, name: e.target.value })} />
                  <KeyValueEditor rows={envDraft.variables} onChange={variables => setEnvDraft({ ...envDraft, variables })} secretToggle compact />
                  <Button className="!min-h-7 !px-2 !text-xs" onPress={saveEnvironment}>保存环境</Button>
                </>
              )}
            </div>

            <div className="postdog-card">
              <div className="postdog-card-title">导入 / 导出</div>
              <textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder="粘贴 curl ..." />
              <div className="postdog-row">
                <Button className="!min-h-7 !px-2 !text-xs" onPress={importCurlText}>导入 curl</Button>
                <Button className="!min-h-7 !px-2 !text-xs" onPress={exportCurrentCurl}>复制为 curl</Button>
              </div>
            </div>

            <div className="postdog-card">
              <div className="postdog-card-title">历史记录</div>
              <HistoryList
                runs={historyRuns}
                loading={historyLoading}
                selectedRunId={selectedHistoryRunId}
                onSelect={openHistoryRun}
              />
            </div>

          </div>
        </section>

        {draft.id && (
          <div className="postdog-footer">
            <Button className="!min-h-7 !px-2 !text-xs !bg-red-50 !text-red-700" onPress={deleteRequest}>删除当前请求</Button>
          </div>
        )}
      </main>
    </div>
  );
}

function RequestButton({ request, selected, onPress, label }) {
  const text = label || request?.name || "";
  return (
    <button type="button" className={`postdog-request-item${selected ? " postdog-selected" : ""}`} onClick={onPress} title={text}>
      <span>{request?.method || ""}</span>
      <strong>{text}</strong>
    </button>
  );
}

function FolderScriptEditor({ folder, onSave }) {
  const [preScript, setPreScript] = useState(folder.preScript || "");
  const [postScript, setPostScript] = useState(folder.postScript || "");

  useEffect(() => {
    setPreScript(folder.preScript || "");
    setPostScript(folder.postScript || "");
  }, [folder.id, folder.preScript, folder.postScript]);

  return (
    <details className="postdog-folder-script">
      <summary>脚本</summary>
      <label>Pre Script</label>
      <textarea wrap="off" spellCheck={false} value={preScript} onChange={e => setPreScript(e.target.value)} placeholder='postdog.request.headers.set("X-Folder", "1")' />
      <label>Post Script</label>
      <textarea wrap="off" spellCheck={false} value={postScript} onChange={e => setPostScript(e.target.value)} placeholder='postdog.env.set("lastStatus", postdog.response.status)' />
      <Button className="!min-h-6 !px-2 !py-0 !text-xs" onPress={() => onSave(folder, { preScript, postScript })}>保存脚本</Button>
    </details>
  );
}

function KeyValueEditor({ title, rows = [], onChange, secretToggle = false, compact = false }) {
  function update(index, patch) {
    onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  }
  function remove(index) {
    onChange(rows.filter((_, i) => i !== index));
  }
  return (
    <div className={compact ? "postdog-kv compact" : "postdog-kv"}>
      {title && <label>{title}</label>}
      {rows.map((row, index) => (
        <div className="postdog-kv-row" key={index}>
          <input title={row.key || ""} value={row.key || ""} onChange={e => update(index, { key: e.target.value })} placeholder="key" />
          <input title={row.value || ""} value={row.value || ""} onChange={e => update(index, { value: e.target.value })} placeholder="value" />
          <label className="postdog-checkbox"><input type="checkbox" checked={row.enabled !== false} onChange={e => update(index, { enabled: e.target.checked })} />启用</label>
          {secretToggle && <label className="postdog-checkbox"><input type="checkbox" checked={row.secret === true} onChange={e => update(index, { secret: e.target.checked })} />密</label>}
          <button type="button" onClick={() => remove(index)}>×</button>
        </div>
      ))}
      <button type="button" className="postdog-add-row" onClick={() => onChange([...(rows || []), { key: "", value: "", enabled: true }])}>+ 添加</button>
    </div>
  );
}

function HistoryList({ runs = [], loading = false, selectedRunId = "", onSelect }) {
  if (loading) return <div className="postdog-empty-response">加载历史...</div>;
  if (!runs.length) return <div className="postdog-empty-response">暂无历史记录</div>;
  return (
    <div className="postdog-history-list">
      {runs.map(run => (
        <button
          key={run.runId}
          type="button"
          className={`postdog-history-item${selectedRunId === run.runId ? " active" : ""}`}
          onClick={() => onSelect(run.runId)}
        >
          <div className="postdog-history-main">
            <span className={`postdog-history-status ${getStatusClass(run.status)}`}>{run.status || 0}</span>
            <strong>{run.durationMs}ms</strong>
          </div>
          <div className="postdog-history-time">{formatDateTime(run.createdAt)}</div>
          <div className="postdog-history-url">{run.method} {run.url}</div>
        </button>
      ))}
    </div>
  );
}

function HeaderTable({ headers = {} }) {
  const entries = Object.entries(headers || {});
  if (entries.length === 0) return <div className="postdog-empty-response">无响应 Header</div>;
  return (
    <div className="postdog-header-table">
      {entries.map(([key, value]) => (
        <div className="postdog-header-row" key={key}>
          <span>{key}</span>
          <code>{String(value)}</code>
        </div>
      ))}
    </div>
  );
}

function MultipartEditor({ rows = [], onChange }) {
  function update(index, patch) {
    onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  }
  function remove(index) {
    onChange(rows.filter((_, i) => i !== index));
  }
  async function selectFile(index, file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      toast.error("单个上传文件不能超过 5 MB");
      return;
    }
    try {
      update(index, {
        kind: "file",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: await fileToBase64(file),
        value: ""
      });
    } catch (error) {
      toast.error(error?.message || "读取文件失败");
    }
  }
  return (
    <div className="postdog-kv postdog-multipart">
      {rows.map((row, index) => (
        <div className="postdog-kv-row" key={index}>
          <input title={row.key || ""} value={row.key || ""} onChange={e => update(index, { key: e.target.value })} placeholder="key" />
          <select value={row.kind === "file" ? "file" : "text"} onChange={e => update(index, { kind: e.target.value, value: "", fileName: "", mimeType: "", dataBase64: "" })}>
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>
          {row.kind === "file" ? (
            <label className="postdog-file-picker">
              <span title={row.fileName || ""}>{row.fileName || "选择文件"}</span>
              <input type="file" onChange={e => selectFile(index, e.target.files?.[0])} />
            </label>
          ) : (
            <input title={row.value || ""} value={row.value || ""} onChange={e => update(index, { value: e.target.value })} placeholder="value" />
          )}
          <label className="postdog-checkbox"><input type="checkbox" checked={row.enabled !== false} onChange={e => update(index, { enabled: e.target.checked })} />启用</label>
          <button type="button" onClick={() => remove(index)}>×</button>
        </div>
      ))}
      <button type="button" className="postdog-add-row" onClick={() => onChange([...rows, { key: "", value: "", kind: "text", enabled: true }])}>+ 添加</button>
    </div>
  );
}

function formatBinaryResponseMessage(response) {
  const contentType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "unknown";
  const size = formatResponseBytes(response.bodySizeBytes);
  return `${response.bodyNote || "二进制响应未展示。"} Content-Type: ${contentType}; Size: ${size}`;
}

function formatRequestBodyForDisplay(body) {
  if (typeof body === "string") return body;
  if (body == null) return "";
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function formatResponseBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function JsonViewer({ value, rootLabel = "root" }) {
  return (
    <div className="postdog-json-tree">
      <JsonNode name={rootLabel} value={value} root />
    </div>
  );
}

function JsonNode({ name, value, root = false }) {
  if (Array.isArray(value)) {
    return (
      <details className="postdog-json-node" open={root || value.length <= 4}>
        <summary>
          {!root && <span className="postdog-json-key">{name}: </span>}
          <span className="postdog-json-punc">[</span>
          <span className="postdog-json-muted">{value.length} items</span>
          <span className="postdog-json-punc">]</span>
        </summary>
        <div className="postdog-json-children">
          {value.map((item, index) => <JsonNode key={index} name={String(index)} value={item} />)}
        </div>
      </details>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      <details className="postdog-json-node" open={root || entries.length <= 6}>
        <summary>
          {!root && <span className="postdog-json-key">{name}: </span>}
          <span className="postdog-json-punc">{"{"}</span>
          <span className="postdog-json-muted">{entries.length} keys</span>
          <span className="postdog-json-punc">{"}"}</span>
        </summary>
        <div className="postdog-json-children">
          {entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} />)}
        </div>
      </details>
    );
  }
  return (
    <div className="postdog-json-leaf">
      <span className="postdog-json-key">{name}: </span>
      <JsonPrimitive value={value} />
    </div>
  );
}

function JsonPrimitive({ value }) {
  if (typeof value === "string") return <span className="postdog-json-string">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="postdog-json-number">{value}</span>;
  if (typeof value === "boolean") return <span className="postdog-json-bool">{String(value)}</span>;
  if (value == null) return <span className="postdog-json-null">null</span>;
  return <span>{String(value)}</span>;
}

function readSavedSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(stored)) return DEFAULT_SIDEBAR_WIDTH;
  return clamp(stored, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
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

function parseJsonForView(text) {
  try {
    return { ok: true, value: parseJsonWithComments(text) };
  } catch (error) {
    return { ok: false, error: error?.message || "JSON 解析失败" };
  }
}

function getStatusClass(status) {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300) return "ok";
  if (code >= 300 && code < 400) return "redirect";
  if (code >= 400) return "error";
  return "unknown";
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
  const blob = new Blob([text], { type: mimeType });
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

function downloadBase64(fileName, dataBase64, mimeType) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  downloadBlob(fileName || "download", blob);
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

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function formatDate(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatDateTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
