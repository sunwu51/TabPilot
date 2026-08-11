/* global chrome */
import { Button, Card, Input, Dialog, Checkbox } from "@sunwu51/camel-ui";
import { useState, useEffect, useRef, useCallback } from "react";
import { connectMcpServer } from "../../api/mcp";
import { BUILTIN_TOOL_NAMES, buildMcpToolCallName } from "../../api/llm";
import toast from "react-hot-toast";
import { useI18n, useLocalizedDom } from "../../i18n";

const MCP_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const MCP_SILENT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * MCP Server configuration component using camel-ui Dialog.
 * Triggered by a button next to the send button.
 * Users can add/remove MCP servers by URL + optional headers.
 *
 * @param {Function} onToolsChanged - called with updated MCP tools array
 */
/* eslint-disable react/prop-types */
export default function McpConfig({ onToolsChanged }) {
  const { t } = useI18n();
  const localizedBodyRef = useLocalizedDom();
  const [servers, setServers] = useState([]);
  const [newType, setNewType] = useState("http");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newHeaders, setNewHeaders] = useState("");
  const [newExtensionId, setNewExtensionId] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [expandedServers, setExpandedServers] = useState({});
  const dialogBodyRef = useRef(null);
  const hasAutoFocusedRef = useRef(false);
  const silentRefreshInFlightRef = useRef(false);

  function focusServerNameInput(container = dialogBodyRef.current) {
    if (!container) return;
    requestAnimationFrame(() => {
      const input = container.querySelector('input[placeholder="my_server"]') || container.querySelector("input");
      input?.focus();
    });
  }

  const handleDialogBodyRef = useCallback((node) => {
    dialogBodyRef.current = node;
    localizedBodyRef(node);
    if (node && !hasAutoFocusedRef.current) {
      hasAutoFocusedRef.current = true;
      focusServerNameInput(node);
    }
    if (!node) {
      hasAutoFocusedRef.current = false;
    }
  }, [localizedBodyRef]);

  function normalizeServerName(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "";
    return trimmed.replace(/[^A-Za-z0-9_]/g, "_");
  }

  function ensureUniqueServerNames(serverList) {
    const used = new Set();
    return serverList.map((server, index) => {
      let baseName = normalizeServerName(server.name || server.serverInfoName || `server_${index + 1}`) || `server_${index + 1}`;
      let nextName = baseName;
      let suffix = 2;
      while (used.has(nextName)) {
        nextName = `${baseName}_${suffix}`;
        suffix += 1;
      }
      used.add(nextName);
      return { ...server, name: nextName };
    });
  }

  function isNestingTool(toolName) {
    // Exact match with a built-in tool name
    if (BUILTIN_TOOL_NAMES.includes(toolName)) return true;
    // Suffix match: check if tool name ends with "_builtinToolName"
    for (const builtinName of BUILTIN_TOOL_NAMES) {
      if (toolName.endsWith("_" + builtinName)) return true;
    }
    return false;
  }

  function buildToolSettings(existingSettings = {}, tools = []) {
    const next = {};
    for (const tool of tools) {
      const prev = existingSettings[tool.name] || {};
      const isNesting = isNestingTool(tool.name);
      next[tool.name] = {
        enabled: isNesting ? (prev.enabled === true) : (prev.enabled !== false),
        dangerous: !!prev.dangerous,
        nesting: isNesting
      };
    }
    return next;
  }

  function getToolSetting(server, toolName) {
    return server.toolSettings?.[toolName] || { enabled: true, dangerous: false };
  }

  function countEnabledTools(serverList) {
    return serverList.reduce((sum, server) => {
      if (!server.enabled || !server.tools) return sum;
      return sum + server.tools.filter(tool => getToolSetting(server, tool.name).enabled !== false).length;
    }, 0);
  }

  /** Load saved servers and keep their session/tool registry fresh in the background. */
  useEffect(() => {
    let disposed = false;

    async function refreshSavedServers() {
      if (silentRefreshInFlightRef.current) return;
      silentRefreshInFlightRef.current = true;
      try {
        const refreshed = await reconnectSavedServers();
        if (disposed) return;
        setServers(refreshed);
        await _saveServers(refreshed);
        if (disposed) return;
        _notifyTools(refreshed, { showWarning: false });
      } catch (error) {
        console.error("Failed to silently refresh MCP servers:", error);
      } finally {
        silentRefreshInFlightRef.current = false;
      }
    }

    void refreshSavedServers();
    const intervalId = setInterval(() => {
      void refreshSavedServers();
    }, MCP_SILENT_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reconnectSavedServers() {
    const { mcpServers } = await chrome.storage.local.get({ mcpServers: [] });
    let reconnected = await Promise.all(
      mcpServers.map(async (s) => {
        const endpoint = s.type === "extension"
          ? { type: "extension", extensionId: s.extensionId, name: s.name }
          : { type: "http", url: s.url, headers: s.headers || {} };
        const result = await connectMcpServer(endpoint);
        return {
          ...s,
          type: s.type === "extension" ? "extension" : "http",
          headers: result.headers || s.headers || {},
          name: s.name || normalizeServerName(result.name) || normalizeServerName(s.url) || `server_${Date.now()}`,
          serverInfoName: result.name || s.serverInfoName || "",
          description: s.description || s.lazyLoadDescription || result.description || "",
          tools: result.tools,
          toolSettings: buildToolSettings(s.toolSettings || {}, result.tools),
          error: result.error,
          enabled: !result.error
        };
      })
    );
    reconnected = ensureUniqueServerNames(reconnected);
    return reconnected;
  }

  /** Notify parent of updated MCP tools with server routing info */
  function _notifyTools(serverList) {
    const allTools = [];
    for (const s of serverList) {
      if (!s.enabled || !s.tools) continue;
      for (const t of s.tools) {
        const settings = getToolSetting(s, t.name);
        if (settings.enabled === false) continue;
        allTools.push({
          ...t,
          _serverId: s.id,
          _serverName: s.name || s.url || s.extensionId,
          _serverUrl: s.url,
          _serverHeaders: s.headers || {},
          _serverType: s.type === "extension" ? "extension" : "http",
          _serverExtensionId: s.extensionId || "",
          _dangerous: !!settings.dangerous,
          _lazyLoad: true,
          _lazyDescription: s.description || s.lazyLoadDescription || "",
          _toolCallName: buildMcpToolCallName(s.name || "server", t.name)
        });
      }
    }
    onToolsChanged(allTools);
  }

  async function _saveServers(serverList) {
    const toSave = serverList.map(s => ({
      id: s.id,
      type: s.type === "extension" ? "extension" : "http",
      url: s.url,
      headers: s.headers,
      extensionId: s.extensionId || "",
      name: s.name,
      serverInfoName: s.serverInfoName || "",
      enabled: s.enabled,
      description: s.description || s.lazyLoadDescription || "",
      toolSettings: s.toolSettings || {}
    }));
    await chrome.storage.local.set({ mcpServers: toSave });
  }

  async function handleConnect() {
    const name = normalizeServerName(newName);
    const url = newUrl.trim();
    const extensionId = newExtensionId.trim();
    if (!name) {
      toast.error("请填写 MCP 名称");
      return;
    }
    if (!MCP_NAME_PATTERN.test(name)) {
      toast.error("名称只能包含字母、数字和下划线");
      return;
    }
    if (servers.some(server => server.name === name)) {
      toast.error("MCP 名称不能重复");
      return;
    }
    if (newType === "http" && !url) {
      toast.error("请填写服务器 URL");
      return;
    }
    if (newType === "extension" && !extensionId) {
      toast.error("请填写插件 ID");
      return;
    }

    let headers = {};
    if (newType === "http" && newHeaders.trim()) {
      try {
        headers = JSON.parse(newHeaders.trim());
      } catch (e) {
        toast.error("Headers JSON 格式错误");
        return;
      }
    }

    setConnecting(true);
    const endpoint = newType === "extension"
      ? { type: "extension", extensionId, name }
      : { type: "http", url, headers };
    const result = await connectMcpServer(endpoint);
    setConnecting(false);

    const server = {
      id: `mcp_${Date.now()}`,
      type: newType,
      url: newType === "http" ? url : "",
      extensionId: newType === "extension" ? extensionId : "",
      name,
      serverInfoName: result.name || "",
      description: result.description || newDescription.trim(),
      tools: result.tools,
      headers: result.headers || (newType === "http" ? headers : {}),
      toolSettings: buildToolSettings({}, result.tools),
      error: result.error,
      enabled: !result.error
    };

    if (result.error) {
      toast.error(`连接失败: ${result.error}`);
    } else {
      toast.success(`已连接「${name}」(${result.tools.length} 个工具)`);
      setNewType("http");
      setNewName("");
      setNewUrl("");
      setNewHeaders("");
      setNewExtensionId("");
      setNewDescription("");
    }

    const updated = [...servers, server];
    setServers(updated);
    _saveServers(updated);
    _notifyTools(updated, { showWarning: true });
  }

  async function handleRemove(id) {
    const updated = servers.filter(s => s.id !== id);
    setServers(updated);
    _saveServers(updated);
    _notifyTools(updated, { showWarning: true });
  }

  async function handleReconnect(server) {
    const endpoint = server.type === "extension"
      ? { type: "extension", extensionId: server.extensionId, name: server.name }
      : { type: "http", url: server.url, headers: server.headers || {} };
    const result = await connectMcpServer(endpoint);
    const updated = servers.map(s =>
      s.id === server.id
        ? {
            ...s,
            serverInfoName: result.name || s.serverInfoName || "",
            description: s.description || s.lazyLoadDescription || result.description || "",
            tools: result.tools,
            headers: result.headers || s.headers || {},
            toolSettings: buildToolSettings(s.toolSettings || {}, result.tools),
            error: result.error,
            enabled: !result.error
          }
        : s
    );
    setServers(updated);
    _saveServers(updated);
    _notifyTools(updated, { showWarning: true });
    if (result.error) toast.error(`重连失败: ${result.error}`);
    else toast.success(`已刷新「${server.name}」工具列表`);
  }

  async function handleToggleTool(serverId, toolName, patch) {
    const updated = servers.map(server =>
      server.id === serverId
        ? {
            ...server,
            toolSettings: {
              ...(server.toolSettings || {}),
              [toolName]: {
                ...getToolSetting(server, toolName),
                ...patch
              }
            }
          }
        : server
    );
    setServers(updated);
    await _saveServers(updated);
    _notifyTools(updated, { showWarning: true });
  }

  async function handleDescriptionChange(server, description) {
    const updated = servers.map(item => item.id === server.id ? { ...item, description } : item);
    setServers(updated);
    await _saveServers(updated);
    _notifyTools(updated, { showWarning: false });
  }

  function toggleExpanded(serverId) {
    setExpandedServers(prev => ({ ...prev, [serverId]: !prev[serverId] }));
  }

  const connectedCount = servers.filter(s => s.enabled).length;
  const totalTools = countEnabledTools(servers);

  return (
    <Dialog trigger={
      <Button className="!text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200">
        MCP{connectedCount > 0 ? ` (${totalTools})` : ""}
      </Button>
    }>
      <div
        ref={handleDialogBodyRef}
        style={{
          width: "min(720px, calc(100vw - 32px))",
          maxWidth: "100%",
          maxHeight: "70vh",
          overflowY: "auto",
          overflowX: "hidden",
          paddingRight: "4px",
          boxSizing: "border-box"
        }}
      >
        <div className="text-sm font-bold text-gray-500 mb-2">MCP 服务器</div>

        {/* Connected servers */}
        {servers.map(s => (
          <Card key={s.id} className="!p-2 mb-2 !w-full !box-border">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${s.enabled ? "bg-green-500" : "bg-red-400"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{s.name || s.url}</div>
                <div className="text-xs text-gray-400">
                  {s.enabled
                    ? `${s.tools?.filter(tool => getToolSetting(s, tool.name).enabled !== false).length || 0}/${s.tools?.length || 0} 个工具`
                    : (s.error || "未连接")}
                </div>
                {s.serverInfoName && s.serverInfoName !== s.name && (
                  <div className="text-xs text-gray-300 truncate">{s.serverInfoName}</div>
                )}
              </div>
              <div className="flex gap-1 flex-shrink-0 flex-wrap justify-end">
                <Button className="!text-xs !p-0 !px-2 !min-h-6" onPress={() => toggleExpanded(s.id)}>
                  {expandedServers[s.id] ? "收起" : "工具"}
                </Button>
                <Button className="!text-xs !p-0 !px-2 !min-h-6" onPress={() => handleReconnect(s)}>刷新</Button>
                <Button className="!text-xs !p-0 !px-2 !min-h-6" onPress={() => handleRemove(s.id)}>删除</Button>
              </div>
            </div>
            {expandedServers[s.id] && s.tools?.length > 0 && (
              <div className="mt-2 border-t border-gray-100 pt-2 flex flex-col gap-2 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 whitespace-nowrap">功能描述</span>
                  <Input
                    aria-label="功能描述"
                    labelClassName="!text-xs !text-gray-500"
                    inputClassName="!min-h-8"
                    defaultValue={s.description || ""}
                    onChange={(value) => handleDescriptionChange(s, value)}
                    placeholder="例如：GitHub repositories, issues, and pull requests"
                  />
                </div>
                <div
                  className="text-xs text-gray-500 break-all whitespace-normal"
                  style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                  title={s.type === "extension" ? s.extensionId : s.url}
                >
                  {s.type === "extension"
                    ? `插件 ID：${s.extensionId || "—"}`
                    : `HTTP URL：${s.url || "—"}`}
                </div>
                {[...s.tools].sort((a, b) => {
                  const aNest = !!getToolSetting(s, a.name).nesting;
                  const bNest = !!getToolSetting(s, b.name).nesting;
                  return aNest - bNest;
                }).map(tool => {
                  const settings = getToolSetting(s, tool.name);
                  return (
                    <div key={tool.name} className={"rounded border p-2 min-w-0 overflow-hidden" + (settings.nesting ? " border-dashed opacity-70" : " border-gray-100")}>
                      <div
                        className="text-xs font-medium break-all"
                        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                      >
                        {tool.name}
                        {settings.nesting && (
                          <span className="text-xs text-amber-600 ml-1">(与内置工具重复)</span>
                        )}
                      </div>
                      <div
                        className="text-xs text-gray-400 mt-1 break-all whitespace-normal"
                        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                      >
                        {tool.description || "无描述"}
                      </div>
                      <div className="flex gap-3 mt-2 flex-wrap">
                        <Checkbox
                          isSelected={settings.enabled !== false}
                          onChange={(checked) => handleToggleTool(s.id, tool.name, { enabled: checked })}
                        >
                          <span className="text-xs">启用</span>
                        </Checkbox>
                        <Checkbox
                          isSelected={!!settings.dangerous}
                          onChange={(checked) => handleToggleTool(s.id, tool.name, { dangerous: checked })}
                        >
                          <span className="text-xs text-red-600">危险工具</span>
                        </Checkbox>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        ))}

        {/* Add new server */}
        <div className="mb-2">
          <div className="text-xs text-gray-500 mb-1">类型</div>
          <div className="flex gap-2">
            <Button
              className={newType === "http" ? "!bg-gray-900 !text-white" : "!bg-gray-100 !text-gray-700"}
              onPress={() => setNewType("http")}
            >
              HTTP
            </Button>
            <Button
              className={newType === "extension" ? "!bg-gray-900 !text-white" : "!bg-gray-100 !text-gray-700"}
              onPress={() => setNewType("extension")}
            >
              Extension
            </Button>
          </div>
        </div>
        <Input
          label="名称"
          labelClassName="!text-xs !text-gray-500"
          inputClassName="!min-h-8"
          autoFocus
          defaultValue={newName}
          onChange={setNewName}
          placeholder="my_server"
        />
        {newType === "http" ? (
          <>
            <Input
              label="服务器 URL"
              labelClassName="!text-xs !text-gray-500"
              inputClassName="!min-h-8"
              defaultValue={newUrl}
              onChange={setNewUrl}
              placeholder="http://localhost:3000/mcp"
            />
            <Input
              label="Headers (JSON, 可选)"
              labelClassName="!text-xs !text-gray-500"
              inputClassName="!min-h-8"
              defaultValue={newHeaders}
              onChange={setNewHeaders}
              placeholder='{"Authorization":"Bearer xx"}'
            />
          </>
        ) : (
          <Input
            label="插件 ID"
            labelClassName="!text-xs !text-gray-500"
            inputClassName="!min-h-8"
            defaultValue={newExtensionId}
            onChange={setNewExtensionId}
            placeholder="abcdefghijklmnopabcdefghijklmnop"
          />
        )}
        <Input label="功能描述" labelClassName="!text-xs !text-gray-500" inputClassName="!min-h-8" defaultValue={newDescription} onChange={setNewDescription} placeholder="可选，描述此 MCP 的主要功能" />
        <div className="mt-2 mb-1 text-xs leading-5 text-amber-700">
          {t("mcpOauthHint")}
        </div>
        <Button
          className="mt-2 w-full"
          isDisabled={connecting || !newName.trim() || (newType === "http" ? !newUrl.trim() : !newExtensionId.trim())}
          onPress={handleConnect}
        >
          {connecting ? "连接中..." : "连接"}
        </Button>
      </div>
    </Dialog>
  );
}
