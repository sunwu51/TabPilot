/* global chrome */
import { Button, Card, Input } from "@sunwu51/camel-ui"
import { useEffect, useState } from "react"
import toast from "react-hot-toast"

export default function Workspace() {
    const [workspaces, setWorkspaces] = useState([])
    const [newName, setNewName] = useState("")
    const [showSave, setShowSave] = useState(false)
    const [restoringId, setRestoringId] = useState(null)
    const [confirmDeleteId, setConfirmDeleteId] = useState(null)

    async function loadWorkspaces() {
        const { workspaces: ws } = await chrome.storage.local.get({ workspaces: [] })
        setWorkspaces(ws)
    }

    useEffect(() => {
        loadWorkspaces()
    }, [])

    async function saveWorkspace() {
        const name = newName.trim()
        if (!name) {
            toast.error("请输入工作区名称")
            return
        }
        const tabs = await chrome.tabs.query({})
        const httpTabs = tabs.filter(t => t.url && t.url.startsWith("http"))
        if (httpTabs.length === 0) {
            toast.error("没有可保存的标签页")
            return
        }
        const ws = {
            id: "ws_" + Date.now(),
            name,
            createdAt: Date.now(),
            tabs: httpTabs.map(t => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl || "" }))
        }
        const { workspaces: existing } = await chrome.storage.local.get({ workspaces: [] })
        existing.unshift(ws)
        await chrome.storage.local.set({ workspaces: existing })
        toast.success(`已保存工作区「${name}」(${httpTabs.length} 个标签)`)
        setShowSave(false)
        setNewName("")
        loadWorkspaces()
    }

    async function restoreWorkspace(ws) {
        setRestoringId(ws.id)
        try {
            // 获取当前已打开的所有标签页URL，去重避免重复打开
            const openTabs = await chrome.tabs.query({})
            const openUrls = new Set(openTabs.map(t => t.url && t.url.split("#")[0]))

            let opened = 0, skipped = 0
            for (const tab of ws.tabs) {
                const urlBase = tab.url.split("#")[0]
                if (openUrls.has(urlBase)) {
                    skipped++
                    continue
                }
                await chrome.tabs.create({ url: tab.url, active: false })
                openUrls.add(urlBase)
                opened++
            }

            if (opened > 0 && skipped > 0) {
                toast.success(`已恢复 ${opened} 个标签，跳过 ${skipped} 个已打开的`)
            } else if (opened > 0) {
                toast.success(`已恢复「${ws.name}」(${opened} 个标签)`)
            } else {
                toast("所有标签页都已经打开了，无需恢复")
            }
        } finally {
            setRestoringId(null)
        }
    }

    async function deleteWorkspace(id) {
        const { workspaces: existing } = await chrome.storage.local.get({ workspaces: [] })
        const updated = existing.filter(w => w.id !== id)
        await chrome.storage.local.set({ workspaces: updated })
        setConfirmDeleteId(null)
        toast.success("已删除")
        loadWorkspaces()
    }

    function formatDate(ts) {
        const d = new Date(ts)
        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    return (
        <Card>
            <div className="flex justify-between items-center pb-1 mb-1" style={{ borderBottom: "1px dashed #d1d5db" }}>
                <span className="text-sm text-gray-500 font-bold" style={{ marginTop: '-10px' }}>工作区</span>
                <Button className="w-24 !text-xs" onPress={() => setShowSave(!showSave)}>
                    {showSave ? "取消" : "保存当前"}
                </Button>
            </div>
            {showSave && (
                <div className="flex gap-1 mb-2">
                    <Input
                        aria-label="工作区名称"
                        inputClassName="!min-h-8 flex-1"
                        placeholder="输入工作区名称"
                        onChange={setNewName}
                        autoFocus={true}
                    />
                    <Button className="!text-xs !whitespace-nowrap flex-shrink-0" onPress={saveWorkspace}>保存</Button>
                </div>
            )}
            {workspaces.length === 0 && (
                <div className="text-xs text-gray-400 text-center py-2">暂无保存的工作区</div>
            )}
            <div className="max-h-40 overflow-y-auto">
                {workspaces.map(ws => (
                    <div key={ws.id} className="flex items-center justify-between py-1 px-1 hover:bg-gray-100 rounded text-xs">
                        <div className="flex-1 truncate">
                            <span className="font-bold">{ws.name}</span>
                            <span className="text-gray-400 ml-1">{ws.tabs.length} 个标签 · {formatDate(ws.createdAt)}</span>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                            <Button
                                className="!text-xs !p-0 !px-2 !min-h-6"
                                isDisabled={restoringId === ws.id}
                                onPress={() => restoreWorkspace(ws)}
                            >
                                {restoringId === ws.id ? "恢复中..." : "恢复"}
                            </Button>
                            {confirmDeleteId === ws.id ? (
                                <>
                                    <Button
                                        className="!text-xs !p-0 !px-2 !min-h-6 !bg-red-500 !text-white"
                                        onPress={() => deleteWorkspace(ws.id)}
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
                                    onPress={() => setConfirmDeleteId(ws.id)}
                                >
                                    删除
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    )
}
