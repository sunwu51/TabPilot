import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listVfsEntries } from "./utils/vfsBrowser";
import { chromeStorageVfs } from "./utils/chromeStorageVfs";
import { LocaleProvider, useI18n } from "./i18n";
import "./files.css";

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
        {selected ? <><div className="preview-toolbar"><strong>{selected.path}</strong>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer">{t("filesOpen", { kind: kindLabel(selected.kind) })}</a>}</div><p>{t("filesRevision", { revision: selected.revision })}</p><pre>{content}</pre></> : <p>{t("filesHint")}</p>}
      </section>
    </div>
  </main>;
}

if (document.getElementById("root")) createRoot(document.getElementById("root")).render(<LocaleProvider><FileManager /></LocaleProvider>);
