/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { tr } from "../../i18n";
import { Badge } from "@sunwu51/camel-ui";
import { PdCheck } from "./PostdogControls";
import { HEADER_NAME_SUGGESTIONS, HEADER_VALUE_SUGGESTIONS, fileToBase64, formatDateTime, getStatusClass } from "./postdogUtils";

export const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;

export function Modal({ title, onClose, children, footer, width = 760, className = "" }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") closeRef.current?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="pd-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`pd-modal ${className}`} style={{ width: `min(${width}px, calc(100vw - 32px))` }} role="dialog" aria-modal="true">
        <div className="pd-modal-header">
          <strong>{title}</strong>
          <button type="button" className="pd-icon-button" onClick={onClose} title={tr("关闭 (Esc)", "Close (Esc)")}>×</button>
        </div>
        <div className="pd-modal-body">{children}</div>
        {footer && <div className="pd-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function KeyValueEditor({ rows = [], onChange, secretToggle = false, keyPlaceholder = "key", valuePlaceholder = "value", maskSecrets = false, headerSuggestions = false }) {
  const [revealed, setRevealed] = useState(() => new Set());
  function update(index, patch) {
    onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  }
  function remove(index) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...(rows || []), { key: "", value: "", enabled: true }]);
  }
  function toggleReveal(index) {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }
  return (
    <div className={`pd-kv${secretToggle ? " with-secret" : ""}`}>
      {headerSuggestions && (
        <>
          <datalist id="pd-header-names">
            {HEADER_NAME_SUGGESTIONS.map(name => <option key={name} value={name} />)}
          </datalist>
          {Object.entries(HEADER_VALUE_SUGGESTIONS).map(([name, values]) => (
            <datalist id={`pd-header-values-${name}`} key={name}>
              {values.map(value => <option key={value} value={value} />)}
            </datalist>
          ))}
        </>
      )}
      <div className="pd-kv-head">
        <span />
        <span>{tr("名称", "Key")}</span>
        <span>{tr("值", "Value")}</span>
        {secretToggle && <span title={tr("敏感值在日志和历史中显示为 ***", "Secret values are masked as *** in logs and history")}>{tr("敏感", "Secret")}</span>}
        <span />
      </div>
      {rows.map((row, index) => {
        const hidden = maskSecrets && row.secret === true && !revealed.has(index);
        return (
          <div className={`pd-kv-row${row.enabled === false ? " disabled" : ""}`} key={index}>
            <PdCheck checked={row.enabled !== false} onChange={enabled => update(index, { enabled })} title={tr("启用", "Enabled")} />
            <input className="pd-kv-key" title={row.key || ""} value={row.key || ""} onChange={e => update(index, { key: e.target.value })} placeholder={keyPlaceholder} spellCheck={false} autoComplete="off" list={headerSuggestions ? "pd-header-names" : undefined} />
            <div className="pd-kv-value-wrap">
              <input
                className="pd-kv-value"
                type={hidden ? "password" : "text"}
                title={hidden ? "" : row.value || ""}
                value={row.value || ""}
                onChange={e => update(index, { value: e.target.value })}
                placeholder={valuePlaceholder}
                spellCheck={false}
                autoComplete="off"
                list={headerSuggestions && HEADER_VALUE_SUGGESTIONS[String(row.key || "").trim().toLowerCase()] ? `pd-header-values-${String(row.key).trim().toLowerCase()}` : undefined}
              />
              {maskSecrets && row.secret === true && (
                <button type="button" className="pd-kv-eye" onClick={() => toggleReveal(index)} title={hidden ? tr("显示", "Show") : tr("隐藏", "Hide")}>
                  {hidden ? "👁" : "◌"}
                </button>
              )}
            </div>
            {secretToggle && (
              <PdCheck checked={row.secret === true} onChange={secret => update(index, { secret })} title={tr("敏感值", "Secret")} />
            )}
            <button type="button" className="pd-icon-button pd-kv-remove" onClick={() => remove(index)} title={tr("删除", "Remove")}>×</button>
          </div>
        );
      })}
      <button type="button" className="pd-add-row" onClick={add}>+ {tr("添加一行", "Add row")}</button>
    </div>
  );
}

export function MultipartEditor({ rows = [], onChange }) {
  function update(index, patch) {
    onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  }
  function remove(index) {
    onChange(rows.filter((_, i) => i !== index));
  }
  async function selectFile(index, file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      toast.error(tr("单个上传文件不能超过 5 MB", "Each upload file must be 5 MB or smaller"));
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
      toast.error(error?.message || tr("读取文件失败", "Failed to read file"));
    }
  }
  return (
    <div className="pd-kv pd-multipart">
      <div className="pd-kv-head">
        <span />
        <span>{tr("名称", "Key")}</span>
        <span>{tr("类型", "Type")}</span>
        <span>{tr("值", "Value")}</span>
        <span />
      </div>
      {rows.map((row, index) => (
        <div className={`pd-kv-row${row.enabled === false ? " disabled" : ""}`} key={index}>
          <PdCheck checked={row.enabled !== false} onChange={enabled => update(index, { enabled })} title={tr("启用", "Enabled")} />
          <input className="pd-kv-key" title={row.key || ""} value={row.key || ""} onChange={e => update(index, { key: e.target.value })} placeholder="key" spellCheck={false} />
          <select value={row.kind === "file" ? "file" : "text"} onChange={e => update(index, { kind: e.target.value, value: "", fileName: "", mimeType: "", dataBase64: "" })}>
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>
          {row.kind === "file" ? (
            <label className="pd-file-picker">
              <span title={row.fileName || ""}>{row.fileName || tr("选择文件…", "Choose file…")}</span>
              <input type="file" onChange={e => selectFile(index, e.target.files?.[0])} />
            </label>
          ) : (
            <input className="pd-kv-value" title={row.value || ""} value={row.value || ""} onChange={e => update(index, { value: e.target.value })} placeholder="value" spellCheck={false} />
          )}
          <button type="button" className="pd-icon-button pd-kv-remove" onClick={() => remove(index)} title={tr("删除", "Remove")}>×</button>
        </div>
      ))}
      <button type="button" className="pd-add-row" onClick={() => onChange([...rows, { key: "", value: "", kind: "text", enabled: true }])}>+ {tr("添加一行", "Add row")}</button>
    </div>
  );
}

const STATUS_VARIANT = { ok: "success", redirect: "primary", error: "danger", unknown: "neutral" };

export function StatusBadge({ status, children }) {
  return <Badge variant={STATUS_VARIANT[getStatusClass(status)]} className="pd-status-badge">{children ?? (status || "ERR")}</Badge>;
}

export function HistoryList({ runs = [], loading = false, selectedRunId = "", onSelect }) {
  if (loading && !runs.length) return <div className="pd-empty">{tr("加载历史...", "Loading history...")}</div>;
  if (!runs.length) return <div className="pd-empty">{tr("暂无历史记录，发送一次请求后会出现在这里", "No history yet. Send the request to record a run.")}</div>;
  return (
    <div className="pd-history-list">
      {runs.map(run => (
        <button
          key={run.runId}
          type="button"
          className={`pd-history-item${selectedRunId === run.runId ? " active" : ""}`}
          onClick={() => onSelect(run.runId)}
        >
          <StatusBadge status={run.status} />
          <span className="pd-history-time">{formatDateTime(run.createdAt)}</span>
          <span className="pd-history-duration">{run.durationMs}ms</span>
          <span className="pd-history-url" title={`${run.method} ${run.url}`}><b>{run.method}</b> {run.url}</span>
        </button>
      ))}
    </div>
  );
}

export function HeaderTable({ headers = {}, emptyText }) {
  const entries = Array.isArray(headers)
    ? headers.map(item => [item.key, item.value])
    : Object.entries(headers || {});
  if (entries.length === 0) return <div className="pd-empty">{emptyText || tr("无 Header", "No headers")}</div>;
  return (
    <div className="pd-header-table">
      {entries.map(([key, value]) => (
        <div className="pd-header-row" key={key}>
          <span>{key}</span>
          <code>{String(value)}</code>
        </div>
      ))}
    </div>
  );
}

export function JsonViewer({ value, rootLabel = "root" }) {
  return (
    <div className="pd-json-tree">
      <JsonNode name={rootLabel} value={value} root />
    </div>
  );
}

function JsonNode({ name, value, root = false }) {
  if (Array.isArray(value)) {
    return (
      <details className="pd-json-node" open={root || value.length <= 20}>
        <summary>
          {!root && <span className="pd-json-key">{name}: </span>}
          <span className="pd-json-punc">[</span>
          <span className="pd-json-muted">{value.length} items</span>
          <span className="pd-json-punc">]</span>
        </summary>
        <div className="pd-json-children">
          {value.map((item, index) => <JsonNode key={index} name={String(index)} value={item} />)}
        </div>
      </details>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      <details className="pd-json-node" open={root || entries.length <= 30}>
        <summary>
          {!root && <span className="pd-json-key">{name}: </span>}
          <span className="pd-json-punc">{"{"}</span>
          <span className="pd-json-muted">{entries.length} keys</span>
          <span className="pd-json-punc">{"}"}</span>
        </summary>
        <div className="pd-json-children">
          {entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} />)}
        </div>
      </details>
    );
  }
  return (
    <div className="pd-json-leaf">
      <span className="pd-json-key">{name}: </span>
      <JsonPrimitive value={value} />
    </div>
  );
}

function JsonPrimitive({ value }) {
  if (typeof value === "string") return <span className="pd-json-string">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="pd-json-number">{value}</span>;
  if (typeof value === "boolean") return <span className="pd-json-bool">{String(value)}</span>;
  if (value == null) return <span className="pd-json-null">null</span>;
  return <span>{String(value)}</span>;
}
