/* global chrome */
/* eslint-disable react-refresh/only-export-components */
/* eslint-disable react/prop-types */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { installWarnFilter } from "./warnFilter";
import { STASH_STORAGE_KEY } from "./api/llm/constants";
import "./index.css";
import "./stash.css";
import "highlight.js/styles/github.css";

installWarnFilter();

const EMPTY_DRAFT = {
  originalTitle: "",
  title: "",
  info: "",
  expireMode: "permanent",
  expireAtText: ""
};

function StashPage() {
  const [stashMap, setStashMap] = useState({});
  const [selectedTitle, setSelectedTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const fileInputRef = useRef(null);

  useEffect(() => {
    void loadStashes();
  }, []);

  useEffect(() => {
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== "local" || !changes[STASH_STORAGE_KEY]) return;
      setStashMap(normalizeStashMap(changes[STASH_STORAGE_KEY].newValue || {}));
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  async function loadStashes() {
    setLoading(true);
    try {
      const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
      setStashMap(normalizeStashMap(result[STASH_STORAGE_KEY] || {}));
    } finally {
      setLoading(false);
    }
  }

  const stashes = useMemo(() => sortStashes(stashMap), [stashMap]);

  useEffect(() => {
    if (stashes.length === 0) {
      setSelectedTitle("");
      return;
    }
    const stillExists = stashes.some(item => item.title === selectedTitle);
    if (!selectedTitle || !stillExists) {
      setSelectedTitle(stashes[0].title);
    }
  }, [selectedTitle, stashes]);

  const selectedStash = stashes.find(item => item.title === selectedTitle) || stashes[0] || null;

  function requestDelete(event, stash) {
    event.stopPropagation();
    setDeleteTarget(stash);
  }

  async function confirmDelete() {
    if (!deleteTarget?.title) return;
    setDeleting(true);
    try {
      const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
      const next = { ...(result[STASH_STORAGE_KEY] || {}) };
      delete next[deleteTarget.title];
      await chrome.storage.local.set({ [STASH_STORAGE_KEY]: next });
      setStashMap(normalizeStashMap(next));
      if (draft.originalTitle === deleteTarget.title) cancelEdit();
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  function startCreate() {
    setDraft({
      ...EMPTY_DRAFT,
      expireMode: "permanent"
    });
    setEditing(true);
  }

  function startEdit() {
    if (!selectedStash) return;
    setDraft({
      originalTitle: selectedStash.title,
      title: selectedStash.title,
      info: selectedStash.info || "",
      expireMode: selectedStash.expireAt === -1 ? "permanent" : "custom",
      expireAtText: selectedStash.expireAt === -1 ? "" : toLocalDatetimeInputValue(selectedStash.expireAt)
    });
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(EMPTY_DRAFT);
  }

  async function saveDraft() {
    const title = draft.title.trim();
    if (!title) {
      window.alert("Title 不能为空");
      return;
    }
    if (draft.expireMode === "custom" && !draft.expireAtText) {
      window.alert("请选择过期时间，或改为永久");
      return;
    }
    const expireAt = draft.expireMode === "permanent"
      ? -1
      : new Date(draft.expireAtText).getTime();
    if (draft.expireMode === "custom" && (!Number.isFinite(expireAt) || expireAt <= Date.now())) {
      window.alert("过期时间必须是未来时间");
      return;
    }

    const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
    const next = { ...(result[STASH_STORAGE_KEY] || {}) };
    const now = Date.now();
    const existing = draft.originalTitle ? next[draft.originalTitle] : null;
    if (draft.originalTitle && draft.originalTitle !== title) {
      delete next[draft.originalTitle];
    }
    next[title] = {
      info: draft.info,
      expireAt,
      createdAt: Number(existing?.createdAt) || Number(existing?.updatedAt) || now,
      updatedAt: now
    };

    await chrome.storage.local.set({ [STASH_STORAGE_KEY]: next });
    setStashMap(normalizeStashMap(next));
    setSelectedTitle(title);
    cancelEdit();
  }

  function exportJsonl() {
    const lines = stashes.map(stash => JSON.stringify({
      title: stash.title,
      info: stash.info,
      expireAt: stash.expireAt,
      createdAt: stash.createdAt,
      updatedAt: stash.updatedAt
    }));
    const blob = new Blob([`${lines.join("\n")}${lines.length ? "\n" : ""}`], { type: "application/x-ndjson;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tabmanager-stashes-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleImportJsonl() {
    setImporting(true);
    try {
      const imported = parseJsonlStashes(importText);
      if (imported.length === 0) {
        window.alert("没有可导入的 stash");
        return;
      }
      const result = await chrome.storage.local.get({ [STASH_STORAGE_KEY]: {} });
      const next = { ...(result[STASH_STORAGE_KEY] || {}) };
      for (const item of imported) {
        next[item.title] = {
          info: item.info,
          expireAt: item.expireAt,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        };
      }
      await chrome.storage.local.set({ [STASH_STORAGE_KEY]: next });
      setStashMap(normalizeStashMap(next));
      setSelectedTitle(imported[0].title);
      setImportText("");
      setShowImport(false);
    } catch (error) {
      window.alert(error?.message || "导入失败");
    } finally {
      setImporting(false);
    }
  }

  async function handleImportFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    setShowImport(true);
  }

  return (
    <div className="stash-page">
      <aside className="stash-sidebar">
        <div className="stash-sidebar-header">
          <div>
            <h1>Stash</h1>
            <p>{loading ? "加载中..." : `${stashes.length} 条记录`}</p>
          </div>
          <div className="stash-header-actions">
            <button type="button" className="stash-icon-btn" onClick={loadStashes} title="刷新">↻</button>
            <button type="button" className="stash-icon-btn" onClick={exportJsonl} title="导出 JSONL">导出</button>
            <button type="button" className="stash-icon-btn" onClick={() => fileInputRef.current?.click()} title="导入 JSONL 文件">导入</button>
            <input ref={fileInputRef} className="stash-hidden-input" type="file" accept=".jsonl,.ndjson,.txt,application/jsonl,application/x-ndjson,text/plain" onChange={handleImportFileChange} />
          </div>
        </div>
        {showImport ? (
          <div className="stash-import-box">
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={"每行一个 JSON，例如：\n{\"title\":\"note\",\"info\":\"# hello\",\"expireAt\":-1}"}
            />
            <div className="stash-import-actions">
              <button type="button" className="stash-cancel-btn" disabled={importing} onClick={() => setShowImport(false)}>取消</button>
              <button type="button" className="stash-primary-btn" disabled={importing} onClick={handleImportJsonl}>{importing ? "导入中..." : "确认导入"}</button>
            </div>
          </div>
        ) : null}

        <div className="stash-list">
          {stashes.length === 0 && !loading ? (
            <div className="stash-empty-list">暂无 stash</div>
          ) : null}
          {stashes.map(stash => (
            <button
              type="button"
              key={stash.title}
              className={`stash-card ${stash.title === selectedStash?.title ? "stash-card-active" : ""}`}
              onClick={() => {
                setSelectedTitle(stash.title);
                if (editing) cancelEdit();
              }}
            >
              <div className="stash-card-main">
                <div className="stash-card-title" title={stash.title}>{stash.title}</div>
                <div className="stash-card-meta">创建：{formatTime(stash.createdAt)}</div>
                <div className="stash-card-meta">过期：{formatExpireTime(stash.expireAt)}</div>
                <div className="stash-card-meta">字符：{stash.charCount}</div>
              </div>
              <span
                role="button"
                tabIndex={0}
                className="stash-delete-btn"
                aria-label={`删除 stash ${stash.title}`}
                title="删除"
                onClick={(event) => requestDelete(event, stash)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") requestDelete(event, stash);
                }}
              >
                🗑
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="stash-content">
        {editing ? (
          <StashEditor
            draft={draft}
            setDraft={setDraft}
            onSave={saveDraft}
            onCancel={cancelEdit}
          />
        ) : selectedStash ? (
          <>
            <div className="stash-content-header">
              <div className="stash-content-title-wrap">
                <h2 title={selectedStash.title}>{selectedStash.title}</h2>
                <div className="stash-content-meta">
                  <span>创建时间：{formatTime(selectedStash.createdAt)}</span>
                  <span>过期时间：{formatExpireTime(selectedStash.expireAt)}</span>
                  <span>字符数：{selectedStash.charCount}</span>
                </div>
              </div>
              <div className="stash-content-actions">
                <button type="button" className="stash-primary-btn" onClick={startCreate}>新增 Stash</button>
                <button type="button" className="stash-secondary-btn" onClick={startEdit}>Edit</button>
              </div>
            </div>
            <MarkdownPreview markdown={selectedStash.info || ""} />
          </>
        ) : (
          <div className="stash-empty-content">
            <div className="stash-empty-icon">🗂️</div>
            <div>还没有可展示的 stash</div>
            <button type="button" className="stash-primary-btn" onClick={startCreate}>新增 Stash</button>
          </div>
        )}
      </main>

      {deleteTarget ? (
        <div className="stash-confirm-backdrop" role="presentation" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="stash-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="stash-delete-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="stash-delete-title">删除 Stash？</h3>
            <p>
              确定要删除「<span>{deleteTarget.title}</span>」吗？此操作不可恢复。
            </p>
            <div className="stash-confirm-actions">
              <button type="button" className="stash-cancel-btn" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button type="button" className="stash-danger-btn" disabled={deleting} onClick={confirmDelete}>
                {deleting ? "删除中..." : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StashEditor({ draft, setDraft, onSave, onCancel }) {
  return (
    <>
      <div className="stash-editor-header">
        <div className="stash-editor-title">
          <h2>{draft.originalTitle ? "Edit Stash" : "新增 Stash"}</h2>
          <div className="stash-editor-fields">
            <label>
              <span>Title</span>
              <input
                value={draft.title}
                onChange={(event) => setDraft(prev => ({ ...prev, title: event.target.value }))}
                placeholder="stash title"
              />
            </label>
            <label>
              <span>过期</span>
              <select
                value={draft.expireMode}
                onChange={(event) => setDraft(prev => ({ ...prev, expireMode: event.target.value }))}
              >
                <option value="permanent">永久</option>
                <option value="custom">自定义时间</option>
              </select>
            </label>
            {draft.expireMode === "custom" ? (
              <label>
                <span>过期时间</span>
                <input
                  type="datetime-local"
                  value={draft.expireAtText}
                  onChange={(event) => setDraft(prev => ({ ...prev, expireAtText: event.target.value }))}
                />
              </label>
            ) : null}
          </div>
        </div>
        <div className="stash-content-actions">
          <button type="button" className="stash-cancel-btn" onClick={onCancel}>取消</button>
          <button type="button" className="stash-primary-btn" onClick={onSave}>保存</button>
        </div>
      </div>
      <div className="stash-editor-body">
        <section className="stash-editor-pane">
          <div className="stash-pane-title">Markdown 原文</div>
          <textarea
            value={draft.info}
            onChange={(event) => setDraft(prev => ({ ...prev, info: event.target.value }))}
            placeholder="输入 Markdown 内容..."
          />
        </section>
        <section className="stash-editor-pane stash-preview-pane">
          <div className="stash-pane-title">预览</div>
          <MarkdownPreview markdown={draft.info || ""} />
        </section>
      </div>
    </>
  );
}

function MarkdownPreview({ markdown }) {
  return (
    <article className="stash-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {markdown || ""}
      </ReactMarkdown>
    </article>
  );
}

function normalizeStashMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const now = Date.now();
  const next = {};
  for (const [title, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    if (value.expireAt !== -1 && Number(value.expireAt) > 0 && now > Number(value.expireAt)) continue;
    next[title] = value;
  }
  return next;
}

function sortStashes(stashMap) {
  return Object.entries(stashMap)
    .map(([title, stash]) => {
      const info = String(stash?.info ?? "");
      return {
        title,
        info,
        expireAt: stash?.expireAt ?? -1,
        updatedAt: Number(stash?.updatedAt) || 0,
        createdAt: Number(stash?.createdAt) || Number(stash?.updatedAt) || 0,
        charCount: Array.from(info).length
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.title.localeCompare(b.title));
}

function parseJsonlStashes(text) {
  const now = Date.now();
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`第 ${index + 1} 行不是合法 JSON: ${error?.message || String(error)}`);
    }
    const title = String(parsed?.title || "").trim();
    if (!title) throw new Error(`第 ${index + 1} 行缺少 title`);
    const expireAt = parsed.expireAt === undefined || parsed.expireAt === null
      ? -1
      : Number(parsed.expireAt);
    if (expireAt !== -1 && (!Number.isFinite(expireAt) || expireAt <= 0)) {
      throw new Error(`第 ${index + 1} 行 expireAt 必须是 -1 或 Unix 毫秒时间戳`);
    }
    return {
      title,
      info: String(parsed?.info ?? ""),
      expireAt,
      createdAt: Number(parsed?.createdAt) || Number(parsed?.updatedAt) || now,
      updatedAt: Number(parsed?.updatedAt) || now
    };
  });
}

function formatTime(value) {
  const timestamp = Number(value);
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString();
}

function formatExpireTime(value) {
  if (value === -1) return "永久";
  return formatTime(value);
}

function toLocalDatetimeInputValue(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

createRoot(document.getElementById("root")).render(<StashPage />);
