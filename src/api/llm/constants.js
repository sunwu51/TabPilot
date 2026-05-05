export const DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
export const DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 60;
export const DEFAULT_BUILTIN_TOOL_TIMEOUT_SECONDS = 10;
export const DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS = 20;
export const MAX_LLM_STREAM_RETRIES = 3;

export const SCHEDULE_STORAGE_KEY = "scheduledJobs";
export const SCHEDULE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SCHEDULE_FIRE_ALARM_PREFIX = "schedule-fire:";
export const SCHEDULE_CLEANUP_ALARM_PREFIX = "schedule-cleanup:";
export const TERMINAL_SCHEDULE_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export const STASH_STORAGE_KEY = "user_stashes";
export const DEFAULT_STASH_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

export const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };
