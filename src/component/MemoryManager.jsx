import { Button, Dialog, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import toast from "react-hot-toast";
import { chromeStorageVfs } from "../utils/chromeStorageVfs";
import { MEMORY_INDEX_PATH } from "../api/llm/tools/builtins/memory";
import { useI18n } from "../i18n";

const TYPES = ["preference", "correction", "decision", "workflow", "entity", "reference"];

export default function MemoryManager() {
  const { t } = useI18n();
  return <Dialog trigger={<Button className="!min-h-7 !px-2 !text-xs">{t("memoryView")}</Button>}><MemoryManagerBody /></Dialog>;
}

function MemoryManagerBody() {
  const { t } = useI18n();
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("全部");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const result = await chromeStorageVfs.readJsonWithStat(MEMORY_INDEX_PATH);
        setItems(Array.isArray(result.value?.items) ? result.value.items : []);
      } catch (error) {
        if (error?.code !== "ENOENT") toast.error(t("memoryReadFailed", { message: error.message }));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...items]
      .filter(item => type === "全部" || item.type === type)
      .filter(item => !needle || [item.subject, item.summary, item.content, ...(item.keywords || []), ...(item.entities || [])].join(" ").toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  }, [items, query, type]);

  return <div className="memory-manager">
    <div className="settings-card-title">{t("memoryTitle")} <span className="text-xs text-gray-400">{t("memoryCountReadonly", { count: items.length })}</span></div>
    <div className="memory-manager-toolbar"><Input aria-label={t("memorySearchLabel")} placeholder={t("memorySearchPlaceholder")} value={query} onChange={setQuery} /><Select aria-label={t("memoryType")} items={[t("memoryAll"), ...TYPES.map(item => t(`memoryType_${item}`))]} defaultIndex={0} onSelectedItemChange={({ selectedItem }) => setType(selectedItem === t("memoryAll") ? "全部" : TYPES.find(item => t(`memoryType_${item}`) === selectedItem) || "全部")} /></div>
    {loading ? <div className="text-sm text-gray-500">加载中...</div> : <div className="memory-manager-content">
      <div className="memory-manager-list">{filtered.map(item => <button type="button" className={`memory-manager-item ${selected?.id === item.id ? "is-selected" : ""}`} key={item.id} onClick={() => setSelected(item)}><strong>{item.subject}</strong><span>{t(`memoryType_${item.type}`)} · {item.summary}</span></button>)}{!filtered.length && <div className="text-sm text-gray-500">{t("memoryNoMatches")}</div>}</div>
      {selected ? <div className="memory-manager-detail"><div className="memory-manager-facts"><MemoryField label={t("memoryType")} value={t(`memoryType_${selected.type}`)} /><MemoryField label={t("memoryImportance")} value={selected.importance ?? 0.5} /></div><MemoryField label={t("memorySubject")} value={selected.subject} /><MemoryField label={t("memorySummary")} value={selected.summary} /><MemoryField label={t("memoryContent")} value={selected.content} multiline /><MemoryField label={t("memoryKeywords")} value={(selected.keywords || []).join(", ") || "—"} /><MemoryField label={t("memoryEntities")} value={(selected.entities || []).join(", ") || "—"} /><div className="memory-manager-facts"><MemoryField label={t("memoryScopeKind")} value={selected.scope?.kind || "global"} /><MemoryField label={t("memoryScopeValue")} value={selected.scope?.value || "—"} /></div><div className="memory-manager-meta">ID: {selected.id}<br />{t("memoryMetadata", { created: new Date(selected.createdAt).toLocaleString(), updated: new Date(selected.updatedAt).toLocaleString(), count: selected.confirmationCount || 1 })}</div></div> : <div className="memory-manager-empty">{t("memorySelectHint")}</div>}
    </div>}
  </div>;
}

function MemoryField({ label, value, multiline = false }) {
  return <div className="memory-manager-field"><span>{label}</span><div className={multiline ? "is-multiline" : ""}>{String(value ?? "—")}</div></div>;
}

MemoryField.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  multiline: PropTypes.bool
};
