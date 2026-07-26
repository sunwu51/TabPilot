/* global chrome */
/* eslint-disable react/prop-types */
import { Button, Dialog, Input } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { normalizeStep, targetToSelectors } from "../../api/macro";

export default function MacroEditor({ macro, onSaved, trigger, replayOptions = { speed: "normal" } }) {
    return (
        <Dialog trigger={trigger || <Button className="!text-xs !p-0 !px-2 !min-h-6">编辑</Button>}>
            <MacroEditorBody macro={macro} onSaved={onSaved} replayOptions={replayOptions} />
        </Dialog>
    );
}

function MacroEditorBody({ macro, onSaved, replayOptions }) {
    const [name, setName] = useState(macro.name);
    const [steps, setSteps] = useState(() => deepCopySteps(toEditorSteps(macro)));
    const [expanded, setExpanded] = useState(() => new Set());
    const [saving, setSaving] = useState(false);
    const [debuggingIndex, setDebuggingIndex] = useState(null);
    const rootRef = useRef(null);

    useEffect(() => {
        setName(macro.name);
        setSteps(deepCopySteps(toEditorSteps(macro)));
    }, [macro]);

    function closeDialog() {
        const closeBtn = rootRef.current?.closest(".dialog-backdrop")?.querySelector(".dialog-close-button");
        closeBtn?.click();
    }

    function toggleExpand(idx) {
        const next = new Set(expanded);
        if (next.has(idx)) next.delete(idx); else next.add(idx);
        setExpanded(next);
    }

    function updateStep(idx, patch) {
        setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
    }

    function updateSelectorAt(stepIdx, selIdx, value) {
        setSteps(prev => prev.map((s, i) => {
            if (i !== stepIdx) return s;
            const selectors = [...(s.selectors || [])];
            selectors[selIdx] = value;
            return { ...s, selectors };
        }));
    }

    function addSelector(stepIdx, value) {
        const v = String(value || "").trim();
        if (!v) return;
        setSteps(prev => prev.map((s, i) => {
            if (i !== stepIdx) return s;
            const selectors = [...(s.selectors || []), v];
            return { ...s, selectors };
        }));
    }

    function removeSelector(stepIdx, selIdx) {
        setSteps(prev => prev.map((s, i) => {
            if (i !== stepIdx) return s;
            const selectors = (s.selectors || []).filter((_, j) => j !== selIdx);
            return { ...s, selectors };
        }));
    }

    function deleteStep(idx) {
        setSteps(prev => prev.filter((_, i) => i !== idx));
        setExpanded(new Set());
    }

    function insertStep(idx, type) {
        const step = createStep(type);
        setSteps(prev => {
            const next = [...prev];
            next.splice(idx, 0, step);
            return next;
        });
        setExpanded(new Set([idx]));
    }

    function cleanupSteps() {
        setSteps(prev => compactSteps(prev));
        setExpanded(new Set());
        toast.success("已清理连续输入 / 重复滚动 / click+submit");
    }

    async function testSelector(selector) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !tab.url.startsWith("http")) {
            toast.error("请先在目标 http(s) 页面上打开标签页");
            return;
        }
        chrome.tabs.sendMessage(tab.id, {
            type: "macro_highlight_selectors",
            selectors: [selector],
            durationMs: 1500
        }, (resp) => {
            if (chrome.runtime.lastError) {
                toast.error(`无法访问页面: ${chrome.runtime.lastError.message}`);
                return;
            }
            if (resp?.success) toast.success("已在页面高亮");
            else toast.error("没找到匹配元素");
        });
    }

    async function save() {
        if (!name.trim()) {
            toast.error("名称不能为空");
            return;
        }
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (!["scroll", "wait", "wait_url", "navigate"].includes(s.type) && (!s.selectors || s.selectors.filter(x => x.trim()).length === 0)) {
                toast.error(`第 ${i + 1} 步至少需要一个 selector`);
                return;
            }
        }
        setSaving(true);
        try {
            const cleanedSteps = steps.map(s => ({
                ...s,
                selectors: (s.selectors || []).map(x => x.trim()).filter(Boolean)
            }));
            const next = { ...macro, name: name.trim(), workflow: { version: 1, steps: cleanedSteps.map(normalizeStep).filter(Boolean) } };
            const res = await sendMacroMessage({ action: "save", payload: next });
            if (res?.success) {
                toast.success("已保存");
                onSaved && onSaved(res.data);
                closeDialog();
            } else {
                toast.error(res?.error || "保存失败");
            }
        } finally {
            setSaving(false);
        }
    }

    async function replayFrom(index, singleStep = false) {
        setDebuggingIndex(index);
        try {
            const tempMacro = { ...macro, name: `${name.trim() || macro.name} (debug)`, workflow: { version: 1, steps: steps.map(normalizeStep).filter(Boolean) } };
            const res = await sendMacroMessage({
                action: "replay_steps",
                payload: { macro: tempMacro, options: { ...replayOptions, startIndex: index, singleStep } }
            });
            if (!res?.success) {
                toast.error(`调试回放失败: ${res?.error || "未知错误"}`);
                return;
            }
            const report = res.report;
            if (report?.ok) toast.success(singleStep ? `第 ${index + 1} 步执行成功` : `从第 ${index + 1} 步回放成功`);
            else if (report) {
                const failed = report.results?.find(r => r.index === report.failedAt);
                toast.error(`第 ${report.failedAt + 1} 步失败：${failed?.error || "未知"}`);
                if (failed?.selectors?.length) console.warn("Macro failed selectors:", failed.selectors, failed);
            }
        } finally {
            setDebuggingIndex(null);
        }
    }

    return (
        <div ref={rootRef} className="flex flex-col gap-2" style={{ maxWidth: 480 }}>
            <div className="text-base font-bold">编辑宏</div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">名称</label>
                <Input
                    aria-label="宏名称"
                    inputClassName="!min-h-8"
                    defaultValue={name}
                    onChange={setName}
                />
                <label className="text-xs text-gray-500 mt-1">起始 URL</label>
                <div className="text-xs px-2 py-1 rounded bg-gray-50 border border-gray-200 break-all">
                    {macro.startUrl}
                </div>
                <div className="text-xs text-gray-400">macro id: {macro.id}</div>
            </div>

            <div className="flex items-center justify-between mt-2">
                <span className="text-sm font-bold text-gray-600">步骤 ({steps.length})</span>
                <div className="flex gap-1">
                    <Button className="!text-xs !p-0 !px-2 !min-h-6" onPress={cleanupSteps}>
                        清理步骤
                    </Button>
                </div>
            </div>

            <div className="max-h-96 overflow-y-auto border border-gray-200 rounded">
                {steps.length === 0 && (
                    <div className="text-xs text-gray-400 text-center py-3">没有任何步骤</div>
                )}
                {steps.map((step, idx) => (
                    <StepRow
                        key={`${idx}-${step.timestamp || ""}`}
                        index={idx}
                        step={step}
                        total={steps.length}
                        expanded={expanded.has(idx)}
                        onToggle={() => toggleExpand(idx)}
                        onUpdate={(patch) => updateStep(idx, patch)}
                        onUpdateSelector={(selIdx, value) => updateSelectorAt(idx, selIdx, value)}
                        onAddSelector={(value) => addSelector(idx, value)}
                        onRemoveSelector={(selIdx) => removeSelector(idx, selIdx)}
                        onDelete={() => deleteStep(idx)}
                        onInsertAfter={(type) => insertStep(idx + 1, type)}
                        onTestSelector={testSelector}
                        onReplayFrom={(singleStep) => replayFrom(idx, singleStep)}
                        debugging={debuggingIndex === idx}
                    />
                ))}
            </div>

            <div className="flex justify-end gap-2 mt-2">
                <Button
                    className="!text-sm !min-h-8 !px-4 !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
                    onPress={closeDialog}
                    isDisabled={saving}
                >
                    取消
                </Button>
                <Button
                    className="!text-sm !min-h-8 !px-4"
                    onPress={save}
                    isDisabled={saving}
                >
                    {saving ? "保存中..." : "保存"}
                </Button>
            </div>
        </div>
    );
}

function StepRow({
    index,
    step,
    expanded,
    onToggle,
    onUpdate,
    onUpdateSelector,
    onAddSelector,
    onRemoveSelector,
    onDelete,
    onInsertAfter,
    onTestSelector,
    onReplayFrom,
    debugging
}) {
    const [newSelector, setNewSelector] = useState("");
    const summary = describeStep(step);
    return (
        <div className="border-b border-gray-100">
            <div className="flex items-center justify-between px-2 py-1 hover:bg-gray-50">
                <button
                    type="button"
                    className="flex-1 text-left text-xs cursor-pointer"
                    onClick={onToggle}
                    title="展开/折叠"
                >
                    <span className="text-gray-400 mr-2">#{index + 1}</span>
                    <span className="font-bold mr-2">{step.type}</span>
                    <span className="text-gray-600">{summary}</span>
                </button>
                <div className="flex gap-1 flex-shrink-0">
                    <Button
                        className="!text-xs !p-0 !px-2 !min-h-6 !bg-red-500 !text-white"
                        onPress={onDelete}
                    >
                        ×
                    </Button>
                    <StepInsertButton onInsert={onInsertAfter} compact />
                </div>
            </div>

            {expanded && (
                <div className="px-3 py-2 bg-gray-50 flex flex-col gap-2 text-xs">
                    {step.type !== "scroll" && (
                        <div className="flex flex-col gap-1">
                            <span className="text-gray-500 font-bold">Selectors（按顺序尝试）</span>
                            {(step.selectors || []).map((sel, sIdx) => (
                                <div key={sIdx} className="flex gap-1 items-center">
                                    <input
                                        className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                        value={sel}
                                        onChange={e => onUpdateSelector(sIdx, e.target.value)}
                                        spellCheck={false}
                                    />
                                    <Button
                                        className="!text-xs !p-0 !px-2 !min-h-6"
                                        onPress={() => onTestSelector(sel)}
                                    >
                                        测试
                                    </Button>
                                    <Button
                                        className="!text-xs !p-0 !px-2 !min-h-6 !bg-red-500 !text-white"
                                        onPress={() => onRemoveSelector(sIdx)}
                                    >
                                        ×
                                    </Button>
                                </div>
                            ))}
                            <div className="flex gap-1 items-center">
                                <input
                                    className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                    placeholder="添加 selector（CSS 或 / 开头的 XPath）"
                                    value={newSelector}
                                    onChange={e => setNewSelector(e.target.value)}
                                />
                                <Button
                                    className="!text-xs !p-0 !px-2 !min-h-6"
                                    onPress={() => {
                                        onAddSelector(newSelector);
                                        setNewSelector("");
                                    }}
                                >
                                    添加
                                </Button>
                            </div>
                        </div>
                    )}

                    {(step.type === "input" || step.type === "change") && (
                        <div className="flex flex-col gap-1">
                            <span className="text-gray-500 font-bold">Value</span>
                            <textarea
                                className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                value={step.value ?? ""}
                                onChange={e => onUpdate({ value: e.target.value })}
                                rows={step.inputKind === "contenteditable" ? 3 : 1}
                            />
                            {step.inputKind && <span className="text-gray-400">inputKind: {step.inputKind}</span>}
                        </div>
                    )}

                    {step.type === "key" && (
                        <div className="flex flex-col gap-1">
                            <span className="text-gray-500 font-bold">Key</span>
                            <input
                                className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                value={step.key ?? ""}
                                onChange={e => onUpdate({ key: e.target.value })}
                            />
                        </div>
                    )}

                    {step.type === "scroll" && (
                        <div className="flex gap-2">
                            <div className="flex-1 flex flex-col gap-1">
                                <span className="text-gray-500 font-bold">scrollX</span>
                                <input
                                    className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                    type="number"
                                    value={step.scrollX ?? 0}
                                    onChange={e => onUpdate({ scrollX: Number(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="flex-1 flex flex-col gap-1">
                                <span className="text-gray-500 font-bold">scrollY</span>
                                <input
                                    className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                    type="number"
                                    value={step.scrollY ?? 0}
                                    onChange={e => onUpdate({ scrollY: Number(e.target.value) || 0 })}
                                />
                            </div>
                        </div>
                    )}

                    {step.type === "wait" && (
                        <NumberField label="durationMs" value={step.durationMs ?? 1000} onChange={v => onUpdate({ durationMs: v })} />
                    )}

                    {step.type === "wait_element" && (
                        <>
                            <SelectField
                                label="state"
                                value={step.state || "visible"}
                                options={["visible", "hidden", "present", "absent"]}
                                onChange={v => onUpdate({ state: v })}
                            />
                            <NumberField label="timeoutMs" value={step.timeoutMs ?? 6000} onChange={v => onUpdate({ timeoutMs: v })} />
                        </>
                    )}

                    {(step.type === "wait_url" || step.type === "navigate") && (
                        <>
                            <TextField label="url" value={step.url ?? ""} onChange={v => onUpdate({ url: v, pattern: step.pattern || v })} />
                            <TextField label="pattern / regex" value={step.pattern ?? ""} onChange={v => onUpdate({ pattern: v })} />
                            <NumberField label="timeoutMs" value={step.timeoutMs ?? 10000} onChange={v => onUpdate({ timeoutMs: v })} />
                        </>
                    )}

                    <div className="flex gap-1">
                        <Button
                            className="!text-xs !p-0 !px-2 !min-h-6"
                            onPress={() => onReplayFrom(true)}
                            isDisabled={debugging}
                        >
                            {debugging ? "执行中..." : "单步执行"}
                        </Button>
                        <Button
                            className="!text-xs !p-0 !px-2 !min-h-6"
                            onPress={() => onReplayFrom(false)}
                            isDisabled={debugging}
                        >
                            从此回放
                        </Button>
                    </div>

                    <div className="text-gray-400">
                        {step.tagName ? `<${step.tagName}>` : ""}
                        {step.text ? ` · "${step.text}"` : ""}
                    </div>
                </div>
            )}
        </div>
    );
}

function StepInsertButton({ onInsert, compact = false }) {
    const [type, setType] = useState("wait_element");
    return (
        <div className="flex gap-1 items-center">
            <select
                className="px-1 py-0.5 border border-gray-300 rounded text-xs"
                value={type}
                onChange={e => setType(e.target.value)}
                title="插入步骤类型"
            >
                {["wait_element", "wait_url", "wait", "navigate", "click", "input", "change", "key", "scroll", "submit"].map(t => (
                    <option key={t} value={t}>{t}</option>
                ))}
            </select>
            <Button className="!text-xs !p-0 !px-2 !min-h-6" onPress={() => onInsert(type)}>
                {compact ? "+" : "插入"}
            </Button>
        </div>
    );
}

function TextField({ label, value, onChange }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-gray-500 font-bold">{label}</span>
            <input
                className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                value={value}
                onChange={e => onChange(e.target.value)}
            />
        </div>
    );
}

function NumberField({ label, value, onChange }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-gray-500 font-bold">{label}</span>
            <input
                className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                type="number"
                value={value}
                onChange={e => onChange(Number(e.target.value) || 0)}
            />
        </div>
    );
}

function SelectField({ label, value, options, onChange }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-gray-500 font-bold">{label}</span>
            <select
                className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                value={value}
                onChange={e => onChange(e.target.value)}
            >
                {options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
        </div>
    );
}

function describeStep(step) {
    switch (step.type) {
        case "click":
            return step.text ? `"${step.text}"` : (step.selectors?.[0] || "");
        case "input":
        case "change":
            return `${step.value === "" ? "(空)" : `"${truncate(step.value, 30)}"`}`;
        case "submit":
            return step.selectors?.[0] || "form";
        case "key":
            return `按键 ${step.key || ""}`;
        case "scroll":
            return `(${step.scrollX || 0}, ${step.scrollY || 0})`;
        case "wait":
            return `${step.durationMs || 0}ms`;
        case "wait_element":
            return `${step.state || "visible"} ${step.selectors?.[0] || ""}`;
        case "wait_url":
            return step.pattern || step.url || "";
        case "navigate":
            return step.url || "";
        default:
            return "";
    }
}

function truncate(s, n) {
    const v = String(s ?? "");
    return v.length > n ? v.slice(0, n) + "…" : v;
}

function deepCopySteps(steps) {
    return (steps || []).map(s => ({ ...s, selectors: [...(s.selectors || [])] }));
}

function toEditorSteps(macro) {
    return (macro?.workflow?.steps || []).map(node => {
        const action = node.do || { type: "wait_for", ...(node.waitFor || {}) };
        const selectors = targetToSelectors(action.target);
        if (action.type === "type") return { ...action, type: "input", value: action.text ?? "", selectors };
        if (action.type === "key_press") return { ...action, type: "key", selectors };
        if (action.type === "wait_for" && action.condition === "url") return { ...action, type: "wait_url", selectors };
        if (action.type === "wait_for") return { ...action, type: "wait_element", selectors };
        return { ...action, selectors };
    });
}

function createStep(type) {
    const base = { type, selectors: [], timestamp: Date.now() };
    switch (type) {
        case "wait":
            return { ...base, durationMs: 1000 };
        case "wait_element":
            return { ...base, state: "visible", timeoutMs: 6000 };
        case "wait_url":
            return { ...base, url: "", pattern: "", timeoutMs: 10000 };
        case "navigate":
            return { ...base, url: "", pattern: "", timeoutMs: 10000 };
        case "input":
        case "change":
            return { ...base, value: "" };
        case "key":
            return { ...base, key: "Enter" };
        case "scroll":
            return { ...base, scrollX: 0, scrollY: 0 };
        default:
            return base;
    }
}

function compactSteps(inputSteps) {
    const out = [];
    const sameInputTarget = (a, b) => (
        a?.type === "input" &&
        b?.type === "input" &&
        (a.selectors?.[0] || "") &&
        (a.selectors?.[0] || "") === (b.selectors?.[0] || "")
    );
    for (const step of inputSteps || []) {
        const prev = out[out.length - 1];
        const prev2 = out[out.length - 2];
        if (sameInputTarget(prev, step)) {
            out[out.length - 1] = step;
            continue;
        }
        if (
            sameInputTarget(prev2, step) &&
            (
                (prev?.type === "scroll" && (prev.scrollX || 0) === 0 && (prev.scrollY || 0) === 0) ||
                (prev?.type === "key" && prev.key === "Enter")
            )
        ) {
            out.splice(out.length - 2, 2, step);
            continue;
        }
        if (prev && step.type === "scroll" && prev.type === "scroll") {
            out[out.length - 1] = step;
            continue;
        }
        if (step.type === "scroll" && (step.scrollX || 0) === 0 && (step.scrollY || 0) === 0 && prev?.type === "input") {
            continue;
        }
        if (step.type === "key" && step.key === "Enter" && prev?.type === "input") {
            continue;
        }
        if (prev && prev.type === "click" && step.type === "submit") {
            out[out.length - 1] = step;
            continue;
        }
        out.push(step);
    }
    return out;
}

function sendMacroMessage(payload) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "macro_manager", ...payload }, response => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response);
        });
    });
}
