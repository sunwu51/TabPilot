/* global chrome */
import { Button, Dialog, Input } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";

export default function MacroEditor({ macro, onSaved, trigger }) {
    return (
        <Dialog trigger={trigger || <Button className="!text-xs !p-0 !px-2 !min-h-6">编辑</Button>}>
            <MacroEditorBody macro={macro} onSaved={onSaved} />
        </Dialog>
    );
}

function MacroEditorBody({ macro, onSaved }) {
    const [name, setName] = useState(macro.name);
    const [steps, setSteps] = useState(() => deepCopySteps(macro.steps));
    const [expanded, setExpanded] = useState(() => new Set());
    const [saving, setSaving] = useState(false);
    const rootRef = useRef(null);

    useEffect(() => {
        setName(macro.name);
        setSteps(deepCopySteps(macro.steps));
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

    function moveStep(idx, delta) {
        const target = idx + delta;
        if (target < 0 || target >= steps.length) return;
        setSteps(prev => {
            const next = [...prev];
            const [item] = next.splice(idx, 1);
            next.splice(target, 0, item);
            return next;
        });
        // Reset expansion to track the moved row.
        setExpanded(new Set());
    }

    function deleteStep(idx) {
        setSteps(prev => prev.filter((_, i) => i !== idx));
        setExpanded(new Set());
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
            if (s.type !== "scroll" && (!s.selectors || s.selectors.filter(x => x.trim()).length === 0)) {
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
            const next = { ...macro, name: name.trim(), steps: cleanedSteps };
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

    return (
        <div ref={rootRef} className="flex flex-col gap-2" style={{ minWidth: 480, maxWidth: 640 }}>
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
                        onMove={(delta) => moveStep(idx, delta)}
                        onDelete={() => deleteStep(idx)}
                        onTestSelector={testSelector}
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
    total,
    expanded,
    onToggle,
    onUpdate,
    onUpdateSelector,
    onAddSelector,
    onRemoveSelector,
    onMove,
    onDelete,
    onTestSelector
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
                        className="!text-xs !p-0 !px-2 !min-h-6"
                        isDisabled={index === 0}
                        onPress={() => onMove(-1)}
                    >
                        ↑
                    </Button>
                    <Button
                        className="!text-xs !p-0 !px-2 !min-h-6"
                        isDisabled={index === total - 1}
                        onPress={() => onMove(1)}
                    >
                        ↓
                    </Button>
                    <Button
                        className="!text-xs !p-0 !px-2 !min-h-6 !bg-red-500 !text-white"
                        onPress={onDelete}
                    >
                        ×
                    </Button>
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
                            <input
                                className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                value={step.value ?? ""}
                                onChange={e => onUpdate({ value: e.target.value })}
                            />
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

                    <div className="text-gray-400">
                        {step.tagName ? `<${step.tagName}>` : ""}
                        {step.text ? ` · "${step.text}"` : ""}
                    </div>
                </div>
            )}
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
