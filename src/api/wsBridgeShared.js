export const WS_BRIDGE_STATUS_STORAGE_KEY = "wsBridgeStatus";

export const DEFAULT_WS_BRIDGE_STATUS = {
  state: "idle",
  url: "",
  error: "",
  updatedAt: 0,
  connectedAt: 0,
  lastHeartbeatAt: 0,
  lastHeartbeatAckAt: 0,
  tools: 0
};

export function getWsBridgeStateMeta(state) {
  switch (state) {
    case "connected":
      return { label: "已连接", color: "#15803d" };
    case "connecting":
      return { label: "连接中", color: "#2563eb" };
    case "reconnecting":
      return { label: "重连中", color: "#c2410c" };
    case "disabled":
      return { label: "已关闭", color: "#6b7280" };
    case "disconnected":
      return { label: "已断开", color: "#b91c1c" };
    case "error":
      return { label: "错误", color: "#b91c1c" };
    default:
      return { label: "未配置", color: "#6b7280" };
  }
}

export function formatWsBridgeStatusTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString();
}
