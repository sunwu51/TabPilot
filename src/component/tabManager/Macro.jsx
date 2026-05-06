/* global chrome */
import { Button, Card, Input } from "@sunwu51/camel-ui";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import MacroEditor from "./MacroEditor";

const RECORDING_KEY = "macroRecording";

export default function Macro() {
    const [macros, setMacros] = useState([]);
    const [recording, setRecording] = useState(null);
    const [showStartForm, setShowStartForm] = useState(false);
    const [newName, setNewName] = useState(defaultMacroName());
    const [search, setSearch] = useState("");
    const [confirmDeleteId, setConfirmDeleteId] = useState(null);
    const [replayingId, setReplayingId] = useState(null);
    const [replaySpeed, setReplaySpeed] = useState("normal");

    async function loadAll() {
        const res = await sendMacroMessage({ action: "list" });
        if (res?.success) setMacros(res.data || []);
        const rec = await sendMacroMessage({ action: "recording_status" });
        setRecording(rec?.data || null);
    }

    useEffect(() => {
        loadAll();
        const handler = (changes, area) => {
            if (area !== "local") return;
            if (changes.macros || changes[RECORDING_KEY]) loadAll();
        };
        chrome.storage.onChanged.addListener(handler);
        return () => chrome.storage.onChanged.removeListener(handler);
    }, []);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return macros;
        return macros.filter(m =>
            m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
        );
    }, [macros, search]);

    async function startRecording() {
        const name = newName.trim() || defaultMacroName();
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.url || !activeTab.url.startsWith("http")) {
            toast.error("请先在一个 http(s) 页面上发起录制");
            return;
        }
        const startUrl = activeTab.url;
        const newTab = await chrome.tabs.create({ url: startUrl, active: true });
        const res = await sendMacroMessage({
            action: "start",
            payload: { name, startUrl, tabId: newTab.id }
        });
        if (!res?.success) {
            toast.error(`启动录制失败: ${res?.error || "未知错误"}`);
            try { await chrome.tabs.remove(newTab.id); } catch { /* ignore */ }
            return;
        }
        toast.success(`已开始录制「${name}」`);
        setShowStartForm(false);
        setNewName(defaultMacroName());
    }

    async function stopRecording(commit) {
        let replacePasswords = false;
        if (commit) {
            const rec = recording || (await sendMacroMessage({ action: "recording_status" }))?.data;
            const hasPassword = rec?.draft?.steps?.some(s => s.type === "input" && s.inputType === "password");
            if (hasPassword) {
                const keepRealPassword = window.confirm(
                    "发现录制过程中有密码输入。\n\n选择“确定”：记录真实密码（将会明文存到本地宏数据中）。\n选择“取消”：用 1A2b3!4399 代替密码。"
                );
                replacePasswords = !keepRealPassword;
            }
        }
        const res = await sendMacroMessage({ action: "stop", payload: { commit, replacePasswords } });
        if (res?.success) {
            const data = res.data;
            if (data?.committed) toast.success(`已保存宏「${data.macro?.name}」(${data.macro?.steps?.length || 0} 步)`);
            else if (data?.discarded) toast("已放弃录制");
            else if (data?.reason === "draft is empty") toast("没有录到任何步骤");
            else toast("已停止录制");
        } else {
            toast.error(res?.error || "停止录制失败");
        }
    }

    async function replayMacro(id) {
        setReplayingId(id);
        try {
            const res = await sendMacroMessage({ action: "replay", payload: { id, options: buildReplayOptions(replaySpeed) } });
            if (!res?.success) {
                toast.error(`回放失败: ${res?.error || "未知错误"}`);
                return;
            }
            const report = res.report;
            if (report?.ok) {
                toast.success(`回放成功 (${report.success}/${report.total})`);
            } else if (report) {
                const failed = report.results?.find(r => r.index === report.failedAt);
                const detail = failed?.usedSelector ? `，selector: ${failed.usedSelector}` : "";
                toast.error(`回放在第 ${report.failedAt + 1} 步失败：${failed?.error || "未知"}${detail}`);
            } else {
                toast.success("已发起回放");
            }
        } finally {
            setReplayingId(null);
        }
    }

    async function deleteMacro(id) {
        const res = await sendMacroMessage({ action: "delete", payload: { id } });
        setConfirmDeleteId(null);
        if (res?.success) {
            toast.success("已删除");
            loadAll();
        } else {
            toast.error(res?.error || "删除失败");
        }
    }

    function copyId(id) {
        navigator.clipboard?.writeText(id).then(
            () => toast.success("已复制 ID"),
            () => toast.error("复制失败")
        );
    }

    return (
        <Card>
            <div className="flex justify-between items-center pb-1 mb-1" style={{ borderBottom: "1px dashed #d1d5db" }}>
                <span className="text-sm text-gray-500 font-bold" style={{ marginTop: '-10px' }}>宏 <span className="text-gray-400">(beta)</span></span>
                <Button className="w-24 !text-xs" onPress={() => setShowStartForm(!showStartForm)} isDisabled={!!recording}>
                    {recording ? "录制中..." : (showStartForm ? "取消" : "新增/录制")}
                </Button>
            </div>

            {recording && (
                <div
                    className="flex items-center justify-between mb-2 px-2 py-1 rounded text-xs"
                    style={{ background: "#fffbeb", border: "1px solid #fcd34d" }}
                >
                    <div className="flex-1 truncate">
                        <span className="font-bold">● 正在录制</span>
                        <span className="ml-1">{recording.draft?.name}</span>
                        <span className="text-gray-500 ml-1">· {recording.draft?.steps?.length || 0} 步</span>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                        <Button
                            className="!text-xs !p-0 !px-2 !min-h-6"
                            onPress={() => stopRecording(true)}
                        >
                            停止并保存
                        </Button>
                        <Button
                            className="!text-xs !p-0 !px-2 !min-h-6 !bg-gray-100 !text-gray-700"
                            onPress={() => stopRecording(false)}
                        >
                            放弃
                        </Button>
                    </div>
                </div>
            )}

            {showStartForm && !recording && (
                <div className="flex gap-1 mb-2">
                    <Input
                        aria-label="宏名称"
                        inputClassName="!min-h-8 flex-1"
                        placeholder="输入宏名称"
                        defaultValue={newName}
                        onChange={setNewName}
                        autoFocus={true}
                    />
                    <Button className="!text-xs !whitespace-nowrap flex-shrink-0" onPress={startRecording}>
                        在新 Tab 录制
                    </Button>
                </div>
            )}

            <div className="mb-2">
                <Input
                    aria-label="搜索宏"
                    inputClassName="!min-h-8"
                    placeholder="按 name / id 搜索"
                    onChange={setSearch}
                />
            </div>

            <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="text-gray-500">回放速度</span>
                <select
                    className="px-2 py-1 border border-gray-300 rounded text-xs"
                    value={replaySpeed}
                    onChange={e => setReplaySpeed(e.target.value)}
                >
                    <option value="slow">慢速</option>
                    <option value="normal">正常</option>
                    <option value="fast">快速</option>
                    <option value="instant">极速</option>
                </select>
                <span className="text-gray-400">每步会高亮目标元素</span>
            </div>

            {macros.length === 0 && (
                <div className="text-xs text-gray-400 text-center py-2">还没有宏，点上方「新增/录制」开始</div>
            )}
            {macros.length > 0 && filtered.length === 0 && (
                <div className="text-xs text-gray-400 text-center py-2">没有匹配的宏</div>
            )}

            <div className="max-h-60 overflow-y-auto">
                {filtered.map(macro => (
                    <div
                        key={macro.id}
                        className="flex items-center justify-between py-1 px-1 hover:bg-gray-100 rounded text-xs"
                    >
                        <div className="flex-1 truncate">
                            <span className="font-bold">{macro.name}</span>
                            <span className="text-gray-400 ml-1">{macro.steps.length} 步</span>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                            <MacroEditor macro={macro} onSaved={loadAll} replayOptions={buildReplayOptions(replaySpeed)} />
                            <Button
                                className="!text-xs !p-0 !px-2 !min-h-6"
                                isDisabled={replayingId === macro.id || !!recording}
                                onPress={() => replayMacro(macro.id)}
                            >
                                {replayingId === macro.id ? "回放中..." : "回放"}
                            </Button>
                            <Button
                                className="!text-xs !p-0 !px-2 !min-h-6 !bg-gray-100 !text-gray-700"
                                onPress={() => copyId(macro.id)}
                            >
                                ID
                            </Button>
                            {confirmDeleteId === macro.id ? (
                                <>
                                    <Button
                                        className="!text-xs !p-0 !px-2 !min-h-6 !bg-red-500 !text-white"
                                        onPress={() => deleteMacro(macro.id)}
                                    >
                                        确认
                                    </Button>
                                    <Button
                                        className="!text-xs !p-0 !px-2 !min-h-6"
                                        onPress={() => setConfirmDeleteId(null)}
                                    >
                                        取消
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    className="!text-xs !p-0 !px-2 !min-h-6"
                                    onPress={() => setConfirmDeleteId(macro.id)}
                                >
                                    删除
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>

        </Card>
    );
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

function defaultMacroName() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `macro_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function buildReplayOptions(speed) {
    return { speed };
}
