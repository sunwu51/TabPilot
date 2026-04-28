import { Toaster } from "react-hot-toast";
import { Tabs, TabsItem } from "@sunwu51/camel-ui";
import Group from "./component/Group";
import Search from "./component/Search";
import Workspace from "./component/Workspace";
import AgentPanel from "./component/agent/AgentPanel";
import SettingsDialog from "./component/SettingsDialog";

/**
 * Root application component with tabs:
 * - Tab Management: search, group, workspace features
 * - Agent: LLM chat with browser context awareness
 * Settings button floats at top-right, visible across all tabs.
 */
function App() {
  return (
    <div className="app-root">
      <div>
        <Toaster />
      </div>
      <div className="settings-float">
        <SettingsDialog />
      </div>
      <Tabs defaultIndex={0} aria-label="main tabs">
        <TabsItem title="标签管理">
          <div className="p-1 relative flex flex-col gap-2">
            <Search />
            <Group />
            <Workspace />
          </div>
        </TabsItem>
        <TabsItem title="小助手">
          <AgentPanel />
        </TabsItem>
      </Tabs>
    </div>
  );
}
export default App;
