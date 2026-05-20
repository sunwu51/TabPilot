export function normalizeSessionPlans(plans) {
  return Array.isArray(plans) ? plans.filter(Boolean) : [];
}
export function getLatestPlan(plans) {
  const normalized = normalizeSessionPlans(plans);
  return normalized.length > 0 ? normalized[normalized.length - 1] : null;
}

export function normalizePlanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step, index) => ({
      id: step?.id || `step_${index + 1}`,
      title: String(step?.title || "").trim(),
      description: String(step?.description || "").trim(),
      status: normalizePlanStepStatus(step?.status || "pending"),
      note: String(step?.note || "").trim(),
      updatedAt: step?.updatedAt || null
    }))
    .filter(step => step.title);
}

export function normalizePlanStepStatus(status) {
  const value = String(status || "pending");
  return ["pending", "in_progress", "completed", "blocked", "skipped"].includes(value) ? value : "pending";
}

export function derivePlanStatus(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) return "draft";
  if (list.some(step => step.status === "blocked")) return "blocked";
  if (list.every(step => step.status === "completed" || step.status === "skipped")) return "completed";
  if (list.some(step => step.status === "in_progress" || step.status === "completed" || step.status === "skipped")) return "in_progress";
  return "approved";
}

export function formatPlanStatus(status) {
  switch (status) {
    case "draft": return "待确认";
    case "approved": return "已确认";
    case "in_progress": return "执行中";
    case "completed": return "已完成";
    case "blocked": return "受阻";
    case "cancelled": return "已取消";
    default: return status || "计划";
  }
}

export function getPlanStepIcon(status) {
  switch (status) {
    case "completed": return "✅";
    case "in_progress": return "🔄";
    case "blocked": return "⛔";
    case "skipped": return "⏭️";
    default: return "⬜";
  }
}

