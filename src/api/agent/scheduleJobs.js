export const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;

/** Next local clock-time occurrence. Walking UTC minutes handles DST gaps and folds. */
export function nextDailyRun(time, timeZone, after) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) throw new Error("Daily time must be HH:mm (00:00–23:59)");
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = Math.floor(after / 60000) * 60000 + 60000;
  for (let minute = 0; minute < 72 * 60; minute++) {
    const timestamp = start + minute * 60000;
    if (formatter.format(new Date(timestamp)) === time) return timestamp;
  }
  throw new Error("Could not find the next daily occurrence");
}

export function nextScheduledRun(job, now) {
  const schedule = job.schedule || (job.repeatSeconds ? { type: "interval", everySeconds: job.repeatSeconds } : { type: "once" });
  if (schedule.type === "daily") return nextDailyRun(schedule.time, schedule.timeZone, now);
  if (schedule.type === "interval") {
    const period = schedule.everySeconds * 1000;
    const anchor = job.cadenceAnchor ?? job.fireTimestamp;
    return anchor + (Math.floor((now - anchor) / period) + 1) * period;
  }
  return null;
}

export function createAgentJob(payload, now = Date.now()) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const input = payload.schedule || {};
  const type = input.type || (payload.repeatSeconds != null ? "interval" : "once");
  if (!["once", "interval", "daily"].includes(type)) throw new Error("Unknown schedule type");
  let schedule;
  let fireTimestamp;
  if (type === "daily") {
    const timeZone = input.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    schedule = { type, time: input.time, timeZone };
    fireTimestamp = nextDailyRun(schedule.time, timeZone, now);
  } else {
    const delay = input.delaySeconds ?? payload.delaySeconds;
    const timestamp = input.timestamp ?? payload.timestamp;
    fireTimestamp = Number(delay) > 0 ? now + Number(delay) * 1000 : timestamp == null ? NaN : Number(timestamp);
    if (type === "interval") {
      const everySeconds = Number(input.everySeconds ?? payload.repeatSeconds);
      if (!Number.isFinite(everySeconds) || everySeconds < 60) throw new Error("Interval must be at least 60 seconds");
      schedule = { type, everySeconds };
      if (delay == null && timestamp == null) fireTimestamp = now + everySeconds * 1000;
    } else schedule = { type };
    if (!Number.isFinite(fireTimestamp) || fireTimestamp < now) throw new Error("Provide a future timestamp or a positive delaySeconds");
  }
  const timeoutSeconds = payload.timeoutSeconds == null ? DEFAULT_AGENT_TIMEOUT_SECONDS : Number(payload.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive");
  return { id: `sched_${crypto.randomUUID()}`, kind: "agent", prompt, label: String(payload.label || "Scheduled assistant"), schedule, cadenceAnchor: fireTimestamp, fireTimestamp, repeatSeconds: type === "interval" ? schedule.everySeconds : null, executeTimeoutMs: timeoutSeconds * 1000, allowDangerousTools: payload.allowDangerousTools === true, status: "pending", startedAt: null, finishedAt: null, expiresAt: null, error: null };
}

export function serializeAgentJob(job, now = Date.now()) {
  return { ...job, scheduleId: job.id, fireAt: new Date(job.fireTimestamp).toLocaleString(), remainingSeconds: job.status === "pending" ? Math.max(0, Math.round((job.fireTimestamp - now) / 1000)) : 0, timeoutSeconds: (job.executeTimeoutMs || 600000) / 1000, sessionId: job.sessionId || job.lastSessionId || null };
}

export function finishAgentJob(job, error, now = Date.now(), retentionMs = 86400000) {
  const next = nextScheduledRun(job, now);
  return { ...job, lastSessionId: job.sessionId, lastRunStatus: error ? "failed" : "succeeded", lastFinishedAt: now, lastError: error || null, finishedAt: now, error: error || null, status: job.pauseAfterRun ? "paused" : next != null ? "pending" : (error ? "failed" : "succeeded"), pauseAfterRun: false, fireTimestamp: next ?? job.fireTimestamp, expiresAt: next != null || job.pauseAfterRun ? null : now + retentionMs };
}
