/* global chrome */
import { Toaster } from "react-hot-toast";
import { useState, useEffect, useRef } from "react";
import { Tabs, TabsItem } from "@sunwu51/camel-ui";
import Group from "./component/tabManager/Group";
import Search from "./component/tabManager/Search";
import Workspace from "./component/tabManager/Workspace";
import Macro from "./component/tabManager/Macro";
import AgentPanel from "./component/agent/AgentPanel";
import BridgePanel from "./component/bridge/BridgePanel";
import SettingsDialog from "./component/SettingsDialog";

/**
 * Root application component with tabs:
 * - Tab Management: search, group, workspace features
 * - Agent: LLM chat with browser context awareness
 * Settings button floats at top-right, visible across all tabs.
 */
function App() {
  const [bridgeEnabled, setBridgeEnabled] = useState(false);
  const bridgeEnabledRef = useRef(false);

  useEffect(() => {
    chrome.storage.local.get({ bridgeEnabled: false }, (res) => {
      setBridgeEnabled(!!res.bridgeEnabled);
      bridgeEnabledRef.current = !!res.bridgeEnabled;
    });
    const handleChange = (changes) => {
      if (changes.bridgeEnabled) {
        const next = !!changes.bridgeEnabled.newValue;
        setBridgeEnabled(next);
        // 关闭工具透出时断开 WebSocket
        if (bridgeEnabledRef.current && !next) {
          chrome.runtime.sendMessage({ type: "wsbridge", action: "disconnect" });
        }
        bridgeEnabledRef.current = next;
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, []);

  useEffect(() => {
    function handleRuntimeMessage(message) {
      if (message?.type !== "focus_agent_panel") return false;
      void (async () => {
        const currentWindow = await chrome.windows.getCurrent();
        if (String(currentWindow?.id || "") !== String(message.windowId || "")) return;
        requestAnimationFrame(() => {
          const agentPanel = document.querySelector(".agent-tab-panel");
          const panels = Array.from(document.querySelectorAll(".tabs-panel, .tabs-panel-selected"));
          const buttons = Array.from(document.querySelectorAll(".tabs-button-container button"));
          const agentPanelWrapper = agentPanel?.closest(".tabs-panel, .tabs-panel-selected");
          const agentIndex = panels.indexOf(agentPanelWrapper);
          if (agentIndex >= 0) buttons[agentIndex]?.click();
        });
      })();
      return false;
    }

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  }, []);

  const tabs = [
    <TabsItem key="tab-mgr" title="标签管理">
      <div className="p-1 relative flex flex-col gap-2">
        <Search />
        <Group />
        <Workspace />
        <Macro />
      </div>
    </TabsItem>,
    <TabsItem key="agent" title="小助手" className="agent-tab-panel">
      <AgentPanel />
    </TabsItem>,
    bridgeEnabled ? (
      <TabsItem key="bridge" title="工具透出">
        <BridgePanel />
      </TabsItem>
    ) : null,
  ].filter(Boolean);

  return (
    <div className="app-root">
      <div>
        <Toaster />
      </div>
      <div className="settings-float">
        <SettingsDialog />
      </div>
      <Tabs defaultIndex={0} aria-label="main tabs">
        {tabs}
      </Tabs>
    </div>
  );
}
export default App;
