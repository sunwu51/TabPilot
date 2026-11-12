import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listVfsEntries } from "./utils/vfsBrowser";
import { chromeStorageVfs } from "./utils/chromeStorageVfs";
import { LocaleProvider, useI18n } from "./i18n";
import { SCRIPTS_DIR, _execEvalJs } from "./api/llm/tools/builtins/evalAndPlayground";
import "./files.css";

/* global chrome */
/* eslint-disable react/prop-types */

/** Saved scripts are the .js files under /scripts; only those get a run bar. */
function isRunnableScript(entry) {
  return entry?.type === "file" && entry.path.startsWith(`${SCRIPTS_DIR}/`) && /\.m?js$/i.test(entry.path);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

/** Pick an open tab and run the selected script in it. */
function ScriptRunner({ path }) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState([]);
  const [tabId, setTabId] = useState("");
  const [argsText, setArgsText] = useState("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState(null);

  async function loadTabs() {
    const all = await chrome.tabs.query({});
    // Scripts can only run on web pages; most recently used tabs first.
    const pages = all.filter(tab => /^https?:/.test(tab.url || "")).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    setTabs(pages);
    setTabId(current => (pages.some(tab => String(tab.id) === String(current)) ? current : String(pages[0]?.id ?? "")));
  }

  useEffect(() => {
    setOutcome(null);
    void loadTabs();
  }, [path]);

  async function run() {
    let args;
    if (argsText.trim()) {
      try {
        args = JSON.parse(argsText);
      } catch {
        setOutcome({ error: t("filesRunBadArgs") });
        return;
      }
    }
    setRunning(true);
    setOutcome(null);
    try {
      const result = await _execEvalJs({ tabId: Number(tabId), path, args });
      setOutcome(result.error ? { error: result.error } : { value: result.result });
    } catch (err) {
      setOutcome({ error: err.message });
    } finally {
      setRunning(false);
    }
  }

  return <div className="script-runner">
    <div className="script-runner-row">
      <label>{t("filesRunIn")}
        <select aria-label={t("filesRunIn")} value={tabId} onChange={event => setTabId(event.target.value)} onFocus={() => void loadTabs()}>
          {tabs.length === 0 && <option value="">{t("filesRunNoTabs")}</option>}
          {tabs.map(tab => <option key={tab.id} value={tab.id}>{(tab.title || tab.url).slice(0, 60)} — {hostOf(tab.url)}</option>)}
        </select>
      </label>
      <button className="primary" onClick={run} disabled={running || !tabId}>{running ? t("filesRunning") : t("filesRun")}</button>
    </div>
    <input aria-label={t("filesRunArgs")} placeholder={t("filesRunArgs")} value={argsText} onChange={event => setArgsText(event.target.value)} />
    {outcome && (outcome.error
      ? <p role="alert">{outcome.error}</p>
      : <pre className="script-result" aria-label={t("filesRunResult")}>{outcome.value === undefined ? "undefined" : JSON.stringify(outcome.value, null, 2)}</pre>)}
  </div>;
}

export function FileManager() {
  const { locale, t } = useI18n();
  const kindLabel = kind => ({ text: t("filesKindText"), directory: t("filesKindDirectory"), stash: "stash", playground: "Playground", webide: "WebIDE" }[kind] || kind);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    document.title = t("fileManager");
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale, t]);

  useEffect(() => {
    let active = true;
    request.current += 1;
    setLoading(true);
    setError("");
    setSelected(null);
    setContent("");
    setEntries([]);
    listVfsEntries({ path }).then(result => {
      if (active) setEntries(result.entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)));
    }).catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, refresh]);

  async function select(entry) {
    const token = ++request.current;
    setSelected(entry);
    setContent("");
    setError("");
    try {
      const text = await chromeStorageVfs.readFile(entry.path);
      if (token === request.current) setContent(text);
    } catch (err) {
      if (token === request.current) setError(err.message);
    }
  }

  return <main>
    <header><h1>{t("fileManager")}</h1><button onClick={() => setRefresh(value => value + 1)}>{t("filesRefresh")}</button></header>
    <nav aria-label={t("filesNavigation")}><button onClick={() => setPath("/")}>{t("filesRoot")}</button>{path.split("/").filter(Boolean).map((part, index, parts) => <button key={index} onClick={() => setPath(`/${parts.slice(0, index + 1).join("/")}`)}>/ {part}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    <div className="file-workspace">
      <section className="file-list" aria-label={t("filesList")}>
        <p className="directory-path">{path}</p>
        {path !== "/" && <button onClick={() => setPath(chromeStorageVfs.parentPath(path))}>📁 ..</button>}
        {loading ? <p>{t("filesLoading")}</p> : entries.length === 0 ? <p>{t("filesEmpty")}</p> : entries.map(entry => <div className="file-row" key={entry.path}>
          <button className={selected?.path === entry.path ? "selected" : ""} onClick={() => entry.type === "directory" ? setPath(entry.path) : void select(entry)}>
            <span>{entry.type === "directory" ? "📁" : "📄"} {entry.title || entry.name}</span><small>{kindLabel(entry.kind)}{entry.type === "file" ? ` · ${entry.size} B` : ""}</small>
          </button>
          {entry.url && <a href={entry.url} target="_blank" rel="noreferrer">{t("filesOpen", { kind: kindLabel(entry.kind) })}</a>}
        </div>)}
      </section>
      <section className="file-preview" aria-label={t("filesTextView")}>
        {selected ? <><div className="preview-toolbar"><strong>{selected.path}</strong>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer">{t("filesOpen", { kind: kindLabel(selected.kind) })}</a>}</div><p>{t("filesRevision", { revision: selected.revision })}</p>{isRunnableScript(selected) && <ScriptRunner path={selected.path} />}<pre>{content}</pre></> : <p>{t("filesHint")}</p>}
      </section>
    </div>
  </main>;
}

if (document.getElementById("root")) createRoot(document.getElementById("root")).render(<LocaleProvider><FileManager /></LocaleProvider>);
