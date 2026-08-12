/* eslint-disable react/prop-types */
import { Button, Checkbox, Dialog, Input } from "@sunwu51/camel-ui";
import { useEffect, useState } from "react";
import { useLocalizedDom } from "../../i18n";

export default function SkillsConfig({
  agentSkills,
  loading,
  skillToolConnected,
  skillBridgeTools,
  onServerUrlChange,
  onBridgeToolDangerousChange,
  onSkillEnabledChange,
  onLoad
}) {
  const rootRef = useLocalizedDom();
  const [serverUrl, setServerUrl] = useState(agentSkills.serverUrl || "");

  useEffect(() => {
    setServerUrl(agentSkills.serverUrl || "");
  }, [agentSkills.serverUrl]);

  const count = agentSkills.skills.length;
  const label = `Skills${count > 0 ? ` (${count})` : ""}`;

  return (
    <Dialog trigger={
      <Button className="!text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200">
        {label}
      </Button>
    }>
      <div
        ref={rootRef}
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
        <div className="text-sm font-bold text-gray-500 mb-2">Skills</div>
        <div className="text-xs text-gray-500 mb-3">
          配置环境变量 `SKILLS_DIR=/path/to/skills`，启动 `npx -y mcp-skill-bridge`，输入默认地址 `http://localhost:5151/mcp`。
        </div>
        <div className="text-xs text-amber-700 mb-3">
          skills 功能处于测试阶段，未必能达到通用 agent 中 skill 的效果。
        </div>

        <Input
          label="skill-bridge 地址"
          labelClassName="!text-xs !text-gray-500"
          inputClassName="!min-h-8"
          defaultValue={serverUrl}
          onChange={(value) => {
            setServerUrl(value);
            onServerUrlChange(value);
          }}
          placeholder="http://localhost:5151/mcp"
        />

        <div className="flex items-center justify-between gap-2 mt-2 mb-3 flex-wrap">
          <div className="text-xs text-gray-400">
            {agentSkills.loadedAt
              ? `已加载 ${count} 个 skills`
              : "尚未加载 skills 索引"}
          </div>
          <Button
            className="!text-xs !p-0 !px-3 !min-h-8"
            isDisabled={loading || !serverUrl.trim()}
            onPress={() => onLoad(serverUrl)}
          >
            {loading ? "Loading..." : "Load"}
          </Button>
        </div>

        <div className={`text-xs mb-3 ${skillToolConnected ? "text-gray-500" : "text-amber-700"}`}>
          {skillToolConnected
            ? "当前会话已自动接入 skill-bridge MCP 工具，可直接调用 get_skill_detail。"
            : "加载成功后，会自动把 skill-bridge 的 MCP 工具加入当前会话。"}
        </div>

        {agentSkills.loadedAt && count > 10 && (
          <div className="text-xs text-amber-700 mb-3">
            当前已加载 {count} 个 skill，建议将 skill 数量控制在 10 个以内。
          </div>
        )}

        {skillBridgeTools.length > 0 && (
          <>
            <div className="text-xs font-medium text-gray-500 mb-2">skill-bridge 工具</div>
            <div className="flex flex-col gap-2 mb-3">
              {skillBridgeTools.map(tool => (
                <div key={tool._toolCallName || tool.name} className="rounded border border-gray-100 p-2 min-w-0 overflow-hidden">
                  <div
                    className="text-xs font-medium break-all"
                    style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                  >
                    {tool.name}
                  </div>
                  <div className="text-xs text-gray-400 mt-1 break-all">
                    {tool.description || "无描述"}
                  </div>
                  <div className="mt-2">
                    <Checkbox
                      isSelected={!!tool._dangerous}
                      onChange={(checked) => onBridgeToolDangerousChange(tool.name, checked)}
                    >
                      <span className="text-xs text-red-600">危险工具</span>
                    </Checkbox>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {count === 0 ? (
          <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded p-3">
            暂无已加载的 skill 索引
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {agentSkills.skills.map(skill => (
              <div key={skill.path} className="rounded border border-gray-100 p-2 min-w-0 overflow-hidden">
                <div
                  className="text-xs font-medium break-all"
                  style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                >
                  {skill.name || "Unnamed Skill"}
                </div>
                <div className="text-xs text-gray-400 mt-1 break-all">{skill.path}</div>
                <div className="text-xs text-gray-500 mt-1 break-all whitespace-normal">
                  {skill.description || "无描述"}
                </div>
                <div className="mt-2">
                  <Checkbox
                    isSelected={skill.enabled !== false}
                    onChange={(checked) => onSkillEnabledChange(skill.path, checked)}
                  >
                    <span className="text-xs text-gray-600">启用 skill</span>
                  </Checkbox>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
