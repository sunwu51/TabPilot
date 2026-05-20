import { _sleepMs } from "./_shared";

export function _execGetCurrentTime() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: now.getTimezoneOffset()
  };
}
export async function _execSleep({ seconds } = {}) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return { error: "seconds is required and must be a number" };
  const intSeconds = Math.floor(n);
  if (intSeconds < 1 || intSeconds > 300) {
    return { error: "seconds must be an integer between 1 and 300 (inclusive)" };
  }
  const startedAt = Date.now();
  await _sleepMs(intSeconds * 1000);
  return {
    success: true,
    requestedSeconds: intSeconds,
    actualMs: Date.now() - startedAt
  };
}
