/* global chrome */
import { serializeAgentJob } from "../../../agent/scheduleJobs";
import { SCHEDULE_CLEANUP_ALARM_PREFIX, SCHEDULE_FIRE_ALARM_PREFIX, SCHEDULE_RETENTION_MS, SCHEDULE_STORAGE_KEY, TERMINAL_SCHEDULE_STATUSES } from "../../core/constants";

function _isTerminalScheduledStatus(status) {
  return TERMINAL_SCHEDULE_STATUSES.has(status);
}

function _buildScheduleFireAlarmName(scheduleId) {
  return `${SCHEDULE_FIRE_ALARM_PREFIX}${scheduleId}`;
}

function _buildScheduleCleanupAlarmName(scheduleId) {
  return `${SCHEDULE_CLEANUP_ALARM_PREFIX}${scheduleId}`;
}

async function _loadScheduledJobsFromStorage() {
  const { [SCHEDULE_STORAGE_KEY]: jobs } = await chrome.storage.local.get({ [SCHEDULE_STORAGE_KEY]: [] });
  return Array.isArray(jobs) ? jobs : [];
}

async function _saveScheduledJobsToStorage(jobs) {
  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: jobs });
}

async function _clearScheduledAlarms(scheduleId) {
  if (!chrome.alarms) return;
  await chrome.alarms.clear(_buildScheduleFireAlarmName(scheduleId));
  await chrome.alarms.clear(_buildScheduleCleanupAlarmName(scheduleId));
}

const _serializeScheduledJob = serializeAgentJob;

async function _pruneExpiredScheduledJobsInStorage() {
  const jobs = await _loadScheduledJobsFromStorage();
  const now = Date.now();
  const kept = [];

  for (const job of jobs) {
    if (job.kind !== "agent" || (_isTerminalScheduledStatus(job?.status) && Number.isFinite(job?.expiresAt) && job.expiresAt <= now)) {
      await _clearScheduledAlarms(job.id);
      continue;
    }
    kept.push(job);
  }

  if (kept.length !== jobs.length) {
    await _saveScheduledJobsToStorage(kept);
  }

  return kept;
}

async function _sendScheduleMessage(action, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "schedule_manager",
      action,
      payload
    });
    return response || { error: "No response from schedule manager" };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

export async function _execScheduleAgent(args = {}) {
  return _sendScheduleMessage("schedule_agent", args);
}

/**
 * List scheduled assistant tasks directly from storage to avoid MV3 service worker
 * wake-up / response jitter in the schedule management UI.
 */
export async function _execListScheduled() {
  const jobs = await _pruneExpiredScheduledJobsInStorage();
  if (jobs.length === 0) {
    return { scheduled: [], message: "No scheduled tasks" };
  }

  return {
    scheduled: jobs
      .slice()
      .sort((a, b) => b.fireTimestamp - a.fireTimestamp)
      .map(_serializeScheduledJob)
  };
}

/**
 * Cancel a pending scheduled assistant task directly in storage.
 * The background service worker still owns creation and execution.
 */
export async function _execCancelScheduled({ scheduleId }) {
  const jobs = await _pruneExpiredScheduledJobsInStorage();
  const index = jobs.findIndex(job => job.id === scheduleId);
  if (index < 0) {
    return { error: `Schedule not found: ${scheduleId}` };
  }

  const cancelled = jobs[index];
  if (cancelled.status !== "pending") {
    return { error: `Schedule ${scheduleId} is already ${cancelled.status}` };
  }

  cancelled.status = "cancelled";
  cancelled.finishedAt = Date.now();
  cancelled.error = null;
  cancelled.expiresAt = cancelled.finishedAt + SCHEDULE_RETENTION_MS;
  await _saveScheduledJobsToStorage(jobs);
  await _clearScheduledAlarms(cancelled.id);

  if (chrome.alarms && Number.isFinite(cancelled.expiresAt)) {
    await chrome.alarms.create(_buildScheduleCleanupAlarmName(cancelled.id), {
      when: Math.max(Date.now(), cancelled.expiresAt)
    });
  }

  return {
    success: true,
    cancelled: {
      scheduleId: cancelled.id,
      label: cancelled.label,
      toolName: cancelled.toolName,
      wasScheduledFor: new Date(cancelled.fireTimestamp).toLocaleString(),
      status: cancelled.status,
      expiresAt: new Date(cancelled.expiresAt).toLocaleString()
    }
  };
}

/**
 * Clear completed scheduled jobs directly in storage.
 */
export async function _execClearCompletedScheduled() {
  const jobs = await _pruneExpiredScheduledJobsInStorage();
  const completedJobs = jobs.filter(job => _isTerminalScheduledStatus(job?.status));
  if (completedJobs.length === 0) {
    return { success: true, removedCount: 0, removedIds: [] };
  }

  const kept = jobs.filter(job => !_isTerminalScheduledStatus(job?.status));
  await _saveScheduledJobsToStorage(kept);

  for (const job of completedJobs) {
    await _clearScheduledAlarms(job.id);
  }

  return {
    success: true,
    removedCount: completedJobs.length,
    removedIds: completedJobs.map(job => job.id)
  };
}
