/* global chrome */
/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { executeTool } from "../../../../api/llm";
import { useI18n } from "../../../../i18n";
import "./ScheduleJobsDialog.css";

export function ScheduleJobsDialogBody({ onOpenSession } = {}) {
  const { locale } = useI18n();
  const L = (zh, en) => locale === "en" ? en : zh;
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [now, setNow] = useState(Date.now());
  async function refresh() {
    const result = await executeTool("list_scheduled", {});
    if (result?.error) throw new Error(result.error);
    setJobs(result?.scheduled || []);
    setError("");
  }
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const result = await executeTool("list_scheduled", {});
        if (!alive) return;
        if (result?.error) throw new Error(result.error);
        setJobs(result?.scheduled || []);
        setError("");
      } catch (err) { if (alive) setError(err.message); }
    };
    void load();
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  async function act(job, operation) {
    if (operation === "delete" && confirmDelete !== job.id) { setConfirmDelete(job.id); return; }
    setBusy(job.id);
    try {
      const result = await chrome.runtime.sendMessage({ type: "schedule_manager", action: "manage_agent", payload: { scheduleId: job.id, operation } });
      if (!result?.success) throw new Error(result?.error || "Task action failed");
      setConfirmDelete(null);
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }
  const statuses = { pending: L("等待执行", "Scheduled"), running: L("运行中", "Running"), paused: L("已暂停", "Paused"), succeeded: L("成功", "Succeeded"), failed: L("失败", "Failed"), cancelled: L("已取消", "Cancelled") };
  return <div className="agent-schedules">
    <header><div><h2>{L("定时助手", "Scheduled assistants")}</h2><p>{L("每次启动新会话，使用相同的任务指令自主执行。", "Each run starts a fresh session with the same task prompt.")}</p></div><button onClick={() => refresh().catch(err => setError(err.message))}>{L("刷新", "Refresh")}</button></header>
    <p className="agent-schedules-hint">{L("固定间隔或每日当地时间执行；重叠的轮次跳过，离线后最多补跑一次。", "Fixed intervals or daily local-time schedules. Overlaps are skipped; missed runs coalesce into one.")}</p>
    {error && <p role="alert">{error}</p>}
    {!jobs.length && <div className="agent-schedules-empty">{L("暂无任务。让助手按指定时间执行一段任务指令即可创建。", "No tasks yet. Ask the assistant to schedule a task prompt.")}</div>}
    {jobs.map(job => <article key={job.id} className="agent-schedule">
      <div className="agent-schedule-title"><strong>{job.label}</strong><span data-status={job.status}>{statuses[job.status] || job.status}</span></div>
      <details><summary>{L("任务指令", "Task prompt")}</summary><pre>{job.prompt}</pre></details>
      <dl><dt>{L("执行方式", "Cadence")}</dt><dd>{job.schedule?.type === "daily" ? L(`每天 ${job.schedule.time}（${job.schedule.timeZone}）`, `Daily ${job.schedule.time} (${job.schedule.timeZone})`) : job.repeatSeconds ? L(`每 ${job.repeatSeconds} 秒（固定间隔）`, `Every ${job.repeatSeconds}s (fixed cadence)`) : L("单次", "Once")}</dd>
      <dt>{L("危险工具", "Dangerous tools")}</dt><dd>{job.allowDangerousTools ? L("允许，无需再次确认", "Allowed without further prompts") : L("禁止", "Blocked")}</dd>
      {job.status === "pending" && <><dt>{L("下次运行", "Next run")}</dt><dd>{job.fireAt} · {Math.max(0, Math.ceil((job.fireTimestamp - now) / 1000))}s</dd></>}
      <dt>{L("运行时限", "Time limit")}</dt><dd>{job.timeoutSeconds}s</dd>
      {job.lastRunStatus && <><dt>{L("最近结果", "Last result")}</dt><dd>{statuses[job.lastRunStatus]} · {new Date(job.lastFinishedAt).toLocaleString()}</dd></>}
      </dl>
      {(job.lastError || job.error) && <p role="alert">{job.lastError || job.error}</p>}
      <footer>
        {job.status !== "running" && <button disabled={busy === job.id} onClick={() => act(job, "run_now")}>{L("立即运行", "Run now")}</button>}
        {job.status === "pending" && <button disabled={busy === job.id} onClick={() => act(job, "pause")}>{L("暂停", "Pause")}</button>}
        {job.status === "paused" && <button disabled={busy === job.id} onClick={() => act(job, "resume")}>{L("恢复", "Resume")}</button>}
        {job.status === "running" ? <button disabled={busy === job.id} onClick={() => act(job, "stop")}>{L("停止", "Stop")}</button> : <button className="danger" disabled={busy === job.id} onClick={() => act(job, "delete")}>{confirmDelete === job.id ? L("确认删除", "Confirm delete") : L("删除", "Delete")}</button>}
        {(job.lastSessionId || job.sessionId) && onOpenSession && <button onClick={() => onOpenSession(job.lastSessionId || job.sessionId)}>{L("查看会话", "View conversation")}</button>}
      </footer>
    </article>)}
    {jobs.some(job => ["succeeded", "failed", "cancelled"].includes(job.status)) && <button onClick={async () => { try { await executeTool("clear_completed_scheduled", {}); await refresh(); } catch (err) { setError(err.message); } }}>{L("清理已结束任务", "Clear finished tasks")}</button>}
  </div>;
}
