import { useEffect, useState } from "react";
import { executeTool } from "../../../../api/llm";
import { Button, Card } from "@sunwu51/camel-ui";
import toast from "react-hot-toast";
import { useLocalizedDom } from "../../../../i18n";
import {
  formatRemainingSeconds,
  formatScheduleStatus,
  getLiveRemainingSeconds,
  isTerminalScheduleStatus,
  normalizeScheduleStatusClass
} from "../utils/scheduleStatus";

export function ScheduleJobsDialogBody() {
  const rootRef = useLocalizedDom();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearingCompleted, setClearingCompleted] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let disposed = false;

    async function loadJobs(showSpinner = false) {
      if (showSpinner) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      try {
        const result = await executeTool("list_scheduled", {});
        if (disposed) return;
        if (result?.error) {
          throw new Error(result.error);
        }
        setJobs(Array.isArray(result?.scheduled) ? result.scheduled : []);
        setError("");
      } catch (err) {
        if (disposed) return;
        setError(err?.message || String(err));
      } finally {
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    loadJobs(true);
    const refreshIntervalId = setInterval(() => {
      loadJobs(false);
    }, 5000);
    const clockIntervalId = setInterval(() => {
      if (!disposed) setNow(Date.now());
    }, 1000);

    return () => {
      disposed = true;
      clearInterval(refreshIntervalId);
      clearInterval(clockIntervalId);
    };
  }, []);

  const hasCompletedJobs = jobs.some((job) => isTerminalScheduleStatus(job?.status));

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const result = await executeTool("list_scheduled", {});
      if (result?.error) {
        throw new Error(result.error);
      }
      setJobs(Array.isArray(result?.scheduled) ? result.scheduled : []);
      setError("");
    } catch (err) {
      setError(err?.message || String(err));
      toast.error(`刷新调度列表失败: ${err?.message || String(err)}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleClearCompleted() {
    setClearingCompleted(true);
    try {
      const result = await executeTool("clear_completed_scheduled", {});
      if (result?.error) {
        throw new Error(result.error);
      }
      const removedCount = Number(result?.removedCount) || 0;
      setJobs((currentJobs) => currentJobs.filter((job) => !isTerminalScheduleStatus(job?.status)));
      setError("");
      toast.success(removedCount > 0 ? `已清理 ${removedCount} 个完成的 job` : "没有可清理的已完成 job");
    } catch (err) {
      setError(err?.message || String(err));
      toast.error(`清理完成 job 失败: ${err?.message || String(err)}`);
    } finally {
      setClearingCompleted(false);
    }
  }

  return (
    <div ref={rootRef} className="schedule-dialog">
      <div className="schedule-dialog-header">
        <div>
          <div className="schedule-dialog-title">Schedule Jobs</div>
          <div className="schedule-dialog-subtitle">显示待执行任务和最近 24 小时内的执行记录</div>
        </div>
        <div className="schedule-dialog-actions">
          <Button
            className="!min-h-8 !px-3 !text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
            onPress={handleRefresh}
            isDisabled={loading || refreshing || clearingCompleted}
          >
            {refreshing ? "刷新中..." : "刷新"}
          </Button>
          <Button
            className="!min-h-8 !px-3 !text-xs !whitespace-nowrap !bg-red-50 !text-red-700 !border !border-red-200 hover:!bg-red-100"
            onPress={handleClearCompleted}
            isDisabled={loading || refreshing || clearingCompleted || !hasCompletedJobs}
          >
            {clearingCompleted ? "删除中..." : "删除结束项"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="schedule-dialog-error">加载失败: {error}</div>
      )}

      {loading && jobs.length === 0 ? (
        <div className="schedule-dialog-empty">正在加载任务…</div>
      ) : jobs.length === 0 ? (
        <div className="schedule-dialog-empty">当前没有可显示的 schedule job</div>
      ) : (
        <div className="schedule-job-list">
          {jobs.map((job) => (
            <Card key={job.id || job.scheduleId} className="schedule-job-card !p-3 !mb-2">
              <div className="schedule-job-row">
                <span className="schedule-job-label">{job.label || job.toolName || "未命名任务"}</span>
                <span className={`schedule-job-status schedule-job-status-${normalizeScheduleStatusClass(job.status)}`}>
                  {formatScheduleStatus(job.status)}
                </span>
              </div>
              <div className="schedule-job-meta">
                <span className="schedule-job-key">ID</span>
                <code className="schedule-job-value">{job.id || job.scheduleId}</code>
              </div>
              <div className="schedule-job-meta">
                <span className="schedule-job-key">预计执行时间</span>
                <span className="schedule-job-value">{job.fireAt || "-"}</span>
              </div>
              {job.status === "pending" && typeof job.remainingSeconds === "number" && (
                <div className="schedule-job-meta">
                  <span className="schedule-job-key">剩余时间</span>
                  <span className="schedule-job-value">
                    {formatRemainingSeconds(getLiveRemainingSeconds(job, now))}
                  </span>
                </div>
              )}
              {job.status === "failed" && job.error && (
                <div className="schedule-job-error">{job.error}</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}














