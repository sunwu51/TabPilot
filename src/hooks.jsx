import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import { useRef } from "react";
import { createEmptyAgentHook, loadAgentHooks, saveAgentHooks } from "./api/agent/hooks";
import "./index.css";

const hookEditorTheme = EditorView.theme({
  "&": { maxHeight: "min(560px, 65vh)" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { minHeight: "320px" }
});

function HooksPage() {
  const [hooks, setHooks] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const selected = hooks.find(hook => hook.id === selectedId) || null;

  useEffect(() => { void reload(); }, []);

  async function reload() {
    setLoading(true);
    const next = await loadAgentHooks();
    setHooks(next);
    setSelectedId(current => next.some(item => item.id === current) ? current : (next[0]?.id || ""));
    setLoading(false);
  }
  async function persist(next) {
    const saved = await saveAgentHooks(next);
    setHooks(saved);
  }
  async function addHook() {
    const hook = createEmptyAgentHook();
    setHooks(current => [...current, hook]);
    setSelectedId(hook.id);
  }
  async function saveHook(nextHook) {
    await persist(hooks.map(hook => hook.id === nextHook.id ? nextHook : hook));
  }
  async function remove(id) {
    await persist(hooks.filter(hook => hook.id !== id));
    if (selectedId === id) setSelectedId("");
  }

  return <main className="min-h-screen overflow-y-auto bg-gray-50 text-gray-900 p-6">
    <div className="max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div><h1 className="text-2xl font-semibold">Agent Hooks</h1><p className="text-sm text-gray-500 mt-1">Hook code runs in an Sval sandbox. Errors and timeouts are skipped.</p></div>
        <button className="px-3 py-2 bg-gray-900 text-white rounded" onClick={addHook}>Add hook</button>
      </header>
      <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-4">
        <aside className="border border-gray-200 bg-white rounded p-2 min-h-[520px]">
          {loading ? <p className="p-3 text-sm text-gray-500">Loading...</p> : hooks.length === 0 ? <p className="p-3 text-sm text-gray-500">No hooks.</p> : hooks.map(hook => <button key={hook.id} onClick={() => setSelectedId(hook.id)} className={`block w-full text-left p-3 rounded mb-1 ${selectedId === hook.id ? "bg-gray-100" : "hover:bg-gray-50"}`}>
            <div className="font-medium text-sm">{hook.name || "Untitled hook"}</div><div className="text-xs text-gray-500 mt-1">{hook.event} · {hook.enabled ? "enabled" : "disabled"}</div>
          </button>)}
        </aside>
        <section className="border border-gray-200 bg-white rounded p-5">
          {!selected ? <p className="text-sm text-gray-500">Select or add a hook.</p> : <HookEditor hook={selected} onSave={saveHook} onDelete={() => remove(selected.id)} />}
        </section>
      </div>
    </div>
  </main>;
}

function HookEditor({ hook, onSave, onDelete }) {
  const [draft, setDraft] = useState(hook);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => setDraft(hook), [hook.id]);
  useEffect(() => { setDirty(false); }, [hook.id]);
  const updateDraft = patch => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setDirty(true);
  };
  return <div className="space-y-4">
    <div className="flex justify-between gap-3"><h2 className="font-semibold">Hook settings</h2><div className="flex gap-3 items-center"><span className="text-xs text-gray-500">{dirty ? "Unsaved changes" : "Saved"}</span><button className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm disabled:opacity-50" disabled={!dirty || saving} onClick={async () => { setSaving(true); await onSave(draft); setSaving(false); setDirty(false); }}> {saving ? "Saving..." : "Save"}</button><button className="text-sm text-red-600" onClick={onDelete}>Delete</button></div></div>
    <label className="block text-sm">Name<input placeholder="Hook name" className="block mt-1 w-full border rounded px-3 py-2" value={draft.name} onChange={event => updateDraft({ name: event.target.value })} /></label>
    <div className="grid grid-cols-3 gap-3">
      <label className="block text-sm">Event<select className="block mt-1 w-full border rounded px-3 py-2" value={draft.event} onChange={event => updateDraft({ event: event.target.value })}><option value="tool.call">tool.call</option><option value="agent.run">agent.run</option><option value="llm.request">llm.request</option><option value="context.compact">context.compact</option><option value="subagent.run">subagent.run</option></select></label>
      <label className="block text-sm">Priority<input type="number" className="block mt-1 w-full border rounded px-3 py-2" value={draft.priority} onChange={event => updateDraft({ priority: Number(event.target.value) })} /></label>
      <label className="block text-sm">Timeout (ms)<input type="number" min="100" max="10000" className="block mt-1 w-full border rounded px-3 py-2" value={draft.timeoutMs} onChange={event => updateDraft({ timeoutMs: Number(event.target.value) })} /></label>
    </div>
    <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => updateDraft({ enabled: event.target.checked })} /> Enabled</label>
    <HookCodeEditor value={draft.code} onChange={code => updateDraft({ code })} />
    <div className="text-xs text-gray-500 space-y-1"><p>函数格式：<code>async (&#123; phase, context, state &#125;) =&gt; &#123; ... &#125;</code>。新建 Hook 时编辑器会填入完整的四阶段打印示例。</p><p><code>before</code>：主操作前，可打印数据、返回 <code>state</code>，也可返回 <code>changes</code>；<code>after</code>：主操作成功后读取 <code>result</code>；<code>error</code>：读取 <code>error</code>；<code>cancel</code>：读取取消原因。</p><p><code>context.data</code> 会随事件变化：工具调用通常包含 <code>tool</code>、<code>args</code>、<code>result</code>；Agent 运行包含 <code>input</code>；压缩包含 <code>messages</code>、<code>previousSummary</code>；可使用 <code>fetch</code>、<code>chrome</code>、<code>llm.profiles()</code> 和 <code>llm.complete()</code>。</p></div>
  </div>;
}

function HookCodeEditor({ value, onChange }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value || "",
        extensions: [lineNumbers(), highlightSpecialChars(), history(), drawSelection(), highlightActiveLine(), bracketMatching(), javascript(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, EditorState.tabSize.of(2), hookEditorTheme, editorPlaceholder("async ({ phase, context, state }) => { ... }") , EditorView.updateListener.of(update => { if (update.docChanged) onChangeRef.current?.(update.state.doc.toString()); })]
      })
    });
    viewRef.current = view;
    return () => view.destroy();
  }, []);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value || "" } });
  }, [value]);
  return <label className="block text-sm">Function source<div ref={hostRef} className="hook-code-editor mt-1 border rounded overflow-hidden min-h-[320px]" /></label>;
}

createRoot(document.getElementById("root")).render(<HooksPage />);
