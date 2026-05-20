export function isTerminalScheduleStatus(status) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
export function formatScheduleStatus(status) {
  switch (status) {
    case "pending": return "待执行";
    case "running": return "执行中";
    case "succeeded": return "已成功";
    case "failed": return "已失败";
    case "cancelled": return "已取消";
    default: return status || "未知";
  }
}

export function normalizeScheduleStatusClass(status) {
  switch (status) {
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "unknown";
  }
}

export function formatRemainingSeconds(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${secs}秒`;
  return `${secs}秒`;
}

export function getLiveRemainingSeconds(job, now = Date.now()) {
  if (!job || job.status !== "pending") return 0;
  const fireAtMs = job.fireAt ? new Date(job.fireAt).getTime() : NaN;
  if (Number.isFinite(fireAtMs)) {
    return Math.max(0, Math.round((fireAtMs - now) / 1000));
  }
  return Math.max(0, Number(job.remainingSeconds) || 0);
}

export function formatJsonFence(value) {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = String(value ?? "");
  }
  return `\`\`\`json\n${text}\n\`\`\``;
}

export function formatTextFence(value) {
  return `\`\`\`text\n${String(value ?? "")}\n\`\`\``;
}
