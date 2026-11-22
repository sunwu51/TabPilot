/* eslint-disable react/prop-types, react-hooks/exhaustive-deps */
import { useEffect, useMemo, useState } from "react";
import { Badge, TabBar } from "@sunwu51/camel-ui";
import toast from "react-hot-toast";
import { tr } from "../../i18n";
import CodeEditor from "./CodeEditor";
import { collectFolderChainScripts, formatDelay } from "../../api/postdog/flowRunner";
import { flowStatusLabel, flowStatusVariant, formatDateTime } from "./postdogUtils";
import { UiButton, UiCombobox, UiSelect } from "../ui/Controls";

const STATUS_ICON = {
  pending: "○",
  running: "◌",
  passed: "✓",
  failed: "✕",
  skipped: "–",
  stopped: "■"
};

function newFlowStep(type, extra = {}) {
  const id = `pds_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  if (type === "delay") return { id, type, ms: 1000, ...extra };
  if (type === "script") return { id, type, script: "", ...extra };
  return { id, type: "request", requestId: "", ...extra };
}

/**
 * Flow editor + run view. `run` is the run shown (live or from history); step statuses come from it.
 * Request step results are rendered by the parent through `renderRequestResult(result, key)`.
 */
export default function FlowPanel({
  flow,
  requests,
  folders,
  folderOptions,
  run,
  runs,
  running,
  runsLoading,
  onChange,
  onDelete,
  onRun,
  onStop,
  onSelectRun,
  onOpenRequest,
  renderRequestResult
}) {
  const [selectedStepId, setSelectedStepId] = useState("");
  const [sideTab, setSideTab] = useState("detail");
  const [inheritFolderId, setInheritFolderId] = useState("");
  const [, setTick] = useState(0);

  const requestsById = useMemo(() => new Map(requests.map(item => [item.id, item])), [requests]);
  const folderPath = useMemo(() => {
    const byId = new Map(folders.map(item => [item.id, item]));
    const cache = new Map();
    const pathOf = id => {
      if (!id || !byId.has(id)) return "";
      if (cache.has(id)) return cache.get(id);
      cache.set(id, byId.get(id).name); // cycle guard
      const parent = pathOf(byId.get(id).parentId);
      const value = parent ? `${parent} / ${byId.get(id).name}` : byId.get(id).name;
      cache.set(id, value);
      return value;
    };
    return pathOf;
  }, [folders]);
  // Type-to-filter options: matches method + name, folder path (hint) and URL (keywords).
  const requestOptions = useMemo(() => requests.map(item => ({
    value: item.id,
    label: `${item.method} ${item.name}`,
    hint: folderPath(item.folderId),
    keywords: item.url
  })), [requests, folderPath]);

  const stepRuns = useMemo(() => new Map((run?.steps || []).map(step => [step.stepId, step])), [run]);
  const selectedStep = flow.steps.find(step => step.id === selectedStepId) || null;
  const selectedRun = selectedStepId ? stepRuns.get(selectedStepId) : null;

  // Countdown for a running delay step.
  const hasRunningDelay = (run?.steps || []).some(step => step.status === "running" && step.type === "delay");
  useEffect(() => {
    if (!hasRunningDelay) return undefined;
    const timer = setInterval(() => setTick(value => value + 1), 200);
    return () => clearInterval(timer);
  }, [hasRunningDelay]);

  // When a run fails, jump to the failing step.
  useEffect(() => {
    if (run?.status !== "failed") return;
    const failed = run.steps.find(step => step.status === "failed");
    if (failed) {
      setSelectedStepId(failed.stepId);
      setSideTab("detail");
    }
  }, [run?.runId, run?.status]);

  function updateSteps(steps) {
    onChange({ ...flow, steps });
  }

  function updateStep(id, patch) {
    updateSteps(flow.steps.map(step => step.id === id ? { ...step, ...patch } : step));
  }

  function addStep(type) {
    const step = newFlowStep(type);
    updateSteps([...flow.steps, step]);
    setSelectedStepId(step.id);
  }

  function moveStep(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= flow.steps.length) return;
    const steps = [...flow.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    updateSteps(steps);
  }

  function removeStep(id) {
    updateSteps(flow.steps.filter(step => step.id !== id));
    if (selectedStepId === id) setSelectedStepId("");
  }

  function inheritFolderScripts() {
    if (!inheritFolderId) {
      toast.error(tr("先选择一个文件夹", "Choose a folder first"));
      return;
    }
    const inherited = collectFolderChainScripts(folders, inheritFolderId);
    if (!inherited.pre && !inherited.post) {
      toast.error(tr("该文件夹及其上级文件夹都没有脚本", "This folder and its parents have no scripts"));
      return;
    }
    const join = (base, extra) => [base, extra.trim()].filter(Boolean).join("\n\n");
    onChange({
      ...flow,
      preScript: join(inherited.pre, flow.preScript || ""),
      postScript: join(inherited.post, flow.postScript || "")
    });
    toast.success(tr(`已复制 ${inherited.folderCount} 层文件夹的脚本到编排脚本开头`, `Copied scripts from ${inherited.folderCount} folder level(s) to the top of the flow scripts`));
  }

  const counts = { passed: 0, failed: 0 };
  for (const step of run?.steps || []) if (counts[step.status] != null) counts[step.status] += 1;

  return (
    <div className="pd-flow">
      <div className="pd-flow-toolbar">
        {running ? (
          <UiButton variant="danger" onClick={onStop}>■ {tr("停止", "Stop")}</UiButton>
        ) : (
          <UiButton variant="primary" onClick={onRun} disabled={flow.steps.length === 0} title="Ctrl/⌘ + Enter">▶ {tr("运行", "Run")}</UiButton>
        )}
        {run && (
          <div className="pd-flow-summary">
            <Badge variant={flowStatusVariant(run.status)}>{flowStatusLabel(run.status)}</Badge>
            <span>{counts.passed}/{run.steps.length} {tr("通过", "passed")}</span>
            {run.finishedAt > 0 && <span>{Math.max(0, run.finishedAt - run.startedAt)} ms</span>}
            <span className="pd-flow-summary-time">{formatDateTime(run.startedAt)}</span>
          </div>
        )}
        <div className="pd-tabs-spacer" />
        <UiButton variant="danger" onClick={onDelete} disabled={running}>{tr("删除编排", "Delete flow")}</UiButton>
      </div>

      <div className="pd-flow-split">
        <section className="pd-pane pd-flow-steps">
          <div className="pd-flow-steps-head">
            <strong>{tr("步骤", "Steps")}</strong>
            <span className="pd-count">{flow.steps.length}</span>
            <div className="pd-tabs-spacer" />
            <UiButton variant="neutral" onClick={() => addStep("request")}>+ {tr("请求", "Request")}</UiButton>
            <UiButton variant="neutral" onClick={() => addStep("delay")}>+ {tr("等待", "Sleep")}</UiButton>
            <UiButton variant="neutral" onClick={() => addStep("script")}>+ {tr("脚本", "Script")}</UiButton>
          </div>
          <div className="pd-scroll pd-flow-step-list">
            {flow.steps.length === 0 && (
              <div className="pd-empty">{tr("还没有步骤。添加请求、等待或脚本步骤，运行时按顺序执行，遇到异常即停止。", "No steps yet. Add request, sleep or script steps; they run in order and stop at the first error.")}</div>
            )}
            {flow.steps.map((step, index) => {
              const stepRun = stepRuns.get(step.id);
              const status = stepRun?.status || "idle";
              const request = step.type === "request" ? requestsById.get(step.requestId) : null;
              const remaining = status === "running" && step.type === "delay" && stepRun?.delayUntil
                ? Math.max(0, stepRun.delayUntil - Date.now())
                : null;
              return (
                <div
                  key={step.id}
                  className={`pd-flow-step status-${status}${selectedStepId === step.id ? " selected" : ""}`}
                  onClick={() => { setSelectedStepId(step.id); setSideTab("detail"); }}
                >
                  <span className="pd-flow-step-icon" title={stepRun ? stepRun.status : ""}>
                    {stepRun ? STATUS_ICON[stepRun.status] || "○" : index + 1}
                  </span>
                  <div className="pd-flow-step-main">
                    {step.type === "request" && (
                      <div className="pd-flow-step-row">
                        <span className="pd-flow-step-type">{tr("请求", "Request")}</span>
                        <UiCombobox
                          className="pd-flow-request-select"
                          size="sm"
                          ariaLabel={tr("请求", "Request")}
                          value={step.requestId}
                          options={requestOptions}
                          onChange={requestId => updateStep(step.id, { requestId })}
                          placeholder={tr("输入名称 / 文件夹 / URL 过滤请求", "Type to filter by name / folder / URL")}
                          emptyText={tr("没有匹配的请求", "No matching requests")}
                        />
                        {request && (
                          <button type="button" className="pd-icon-button" title={tr("打开这个请求", "Open this request")} onClick={e => { e.stopPropagation(); onOpenRequest(request.id); }}>↗</button>
                        )}
                      </div>
                    )}
                    {step.type === "request" && step.requestId && !request && (
                      <div className="pd-flow-step-error">{tr("引用的请求已不存在", "The referenced request no longer exists")}</div>
                    )}
                    {step.type === "delay" && (
                      <div className="pd-flow-step-row">
                        <span className="pd-flow-step-type">{tr("等待", "Sleep")}</span>
                        <input
                          className="pd-flow-ms"
                          type="number"
                          min={0}
                          step={100}
                          value={step.ms}
                          onClick={e => e.stopPropagation()}
                          onChange={e => updateStep(step.id, { ms: Math.max(0, Number(e.target.value) || 0) })}
                        />
                        <span className="pd-help inline">ms</span>
                        {remaining != null && <span className="pd-flow-countdown">{tr("剩余", "left")} {(remaining / 1000).toFixed(1)}s</span>}
                      </div>
                    )}
                    {step.type === "script" && (
                      <>
                        <div className="pd-flow-step-row">
                          <span className="pd-flow-step-type">{tr("脚本", "Script")}</span>
                          <span className="pd-help inline">{tr("不发请求，可读写环境变量、用 $.assert 校验", "No request; read / write variables, check with $.assert")}</span>
                        </div>
                        <div className="pd-flow-step-code" onClick={e => e.stopPropagation()}>
                          <CodeEditor
                            docKey={`${flow.id}:${step.id}`}
                            language="javascript"
                            value={step.script || ""}
                            onChange={script => updateStep(step.id, { script })}
                            placeholder={'$.assert($.env.get("token"), "token is missing");'}
                          />
                        </div>
                      </>
                    )}
                    {stepRun?.status === "failed" && stepRun.error && <div className="pd-flow-step-error" title={stepRun.error}>{stepRun.error}</div>}
                  </div>
                  {stepRun?.durationMs != null && stepRun.status !== "running" && <span className="pd-flow-step-time">{stepRun.durationMs} ms</span>}
                  <div className="pd-flow-step-actions" onClick={e => e.stopPropagation()}>
                    <button type="button" className="pd-icon-button" disabled={index === 0} onClick={() => moveStep(index, -1)} title={tr("上移", "Move up")}>↑</button>
                    <button type="button" className="pd-icon-button" disabled={index === flow.steps.length - 1} onClick={() => moveStep(index, 1)} title={tr("下移", "Move down")}>↓</button>
                    <button type="button" className="pd-icon-button danger" onClick={() => removeStep(step.id)} title={tr("删除步骤", "Remove step")}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="pd-pane pd-flow-side">
          <TabBar
            className="pd-tabs"
            variant="line"
            aria-label={tr("编排", "Flow")}
            selectedKey={sideTab}
            onChange={setSideTab}
            items={[
              { key: "detail", title: tr("执行详情", "Step result") },
              { key: "scripts", title: tr("编排脚本", "Flow scripts"), dot: !!(flow.preScript?.trim() || flow.postScript?.trim()) },
              { key: "runs", title: tr("运行记录", "Runs"), count: runs.length }
            ]}
          />
          <div className="pd-pane-body">
            {sideTab === "scripts" ? (
              <div className="pd-flow-scripts">
                <p className="pd-help">
                  {tr(
                    "编排 Pre / Post 在每个请求步骤前后各执行一次。顺序：文件夹 Pre → 编排 Pre → 请求 Pre → 发送 → 请求 Post → 编排 Post → 文件夹 Post。任一脚本抛出异常（如 $.assert 失败）该步骤即失败，编排停止；状态码不影响结果。",
                    "Flow pre / post run around every request step. Order: folder pre → flow pre → request pre → send → request post → flow post → folder post. A step fails when any script throws (e.g. a failed $.assert) and the flow stops; the status code does not matter."
                  )}
                </p>
                <div className="pd-flow-inherit">
                  <span>{tr("继承文件夹脚本", "Inherit folder scripts")}</span>
                  <UiSelect
                    className="pd-flow-inherit-select"
                    size="sm"
                    ariaLabel={tr("文件夹", "Folder")}
                    value={inheritFolderId}
                    options={[{ value: "", label: tr("（选择文件夹）", "(choose a folder)") }, ...folderOptions]}
                    onChange={setInheritFolderId}
                  />
                  <UiButton variant="neutral" onClick={inheritFolderScripts} disabled={!inheritFolderId}>{tr("复制到下方", "Copy below")}</UiButton>
                  <span className="pd-help inline">{tr("会把该文件夹及所有上级的 Pre / Post 按父→子顺序复制到脚本开头", "Copies the pre / post scripts of the folder and all its parents (parent → child) to the top")}</span>
                </div>
                <div className="pd-flow-script-pair">
                  <div className="pd-folder-script">
                    <div className="pd-section-title">{tr("编排 Pre Script", "Flow pre script")}</div>
                    <CodeEditor
                      docKey={`${flow.id}:flow-pre`}
                      language="javascript"
                      value={flow.preScript || ""}
                      onChange={preScript => onChange({ ...flow, preScript })}
                      placeholder={'$.request.headers.set("Authorization", "Bearer " + $.env.get("token"));'}
                    />
                  </div>
                  <div className="pd-folder-script">
                    <div className="pd-section-title">{tr("编排 Post Script", "Flow post script")}</div>
                    <CodeEditor
                      docKey={`${flow.id}:flow-post`}
                      language="javascript"
                      value={flow.postScript || ""}
                      onChange={postScript => onChange({ ...flow, postScript })}
                      placeholder={'$.assert($.response.ok, "HTTP " + $.response.status);'}
                    />
                  </div>
                </div>
              </div>
            ) : sideTab === "runs" ? (
              <div className="pd-scroll">
                {runsLoading && runs.length === 0 ? <div className="pd-empty">{tr("加载中...", "Loading...")}</div> : runs.length === 0 ? (
                  <div className="pd-empty">{tr("还没有运行记录", "No runs yet")}</div>
                ) : (
                  <div className="pd-flow-runs">
                    {runs.map(item => {
                      const passed = (item.steps || []).filter(step => step.status === "passed").length;
                      return (
                        <button
                          key={item.runId}
                          type="button"
                          className={`pd-flow-run-item${run?.runId === item.runId ? " selected" : ""}`}
                          onClick={() => { onSelectRun(item.runId); setSideTab("detail"); }}
                        >
                          <Badge variant={flowStatusVariant(item.status)}>{flowStatusLabel(item.status)}</Badge>
                          <span>{formatDateTime(item.startedAt)}</span>
                          <span className="pd-help inline">{passed}/{(item.steps || []).length}</span>
                          {item.finishedAt > 0 && <span className="pd-help inline">{item.finishedAt - item.startedAt} ms</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <StepDetail
                step={selectedStep}
                stepRun={selectedRun}
                runKey={`${run?.runId || ""}:${selectedStepId}`}
                renderRequestResult={renderRequestResult}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StepDetail({ step, stepRun, runKey, renderRequestResult }) {
  if (!step && !stepRun) {
    return <div className="pd-empty pd-response-empty">{tr("点击左侧步骤查看本次执行详情", "Click a step to see its result in this run")}</div>;
  }
  if (!stepRun || stepRun.status === "pending") {
    return <div className="pd-empty pd-response-empty">{tr("这个步骤在本次运行中还没有执行", "This step has not run in this run")}</div>;
  }
  if (stepRun.status === "running") {
    return <div className="pd-empty pd-response-empty">{tr("执行中…", "Running…")}</div>;
  }
  if (stepRun.status === "skipped") {
    return <div className="pd-empty pd-response-empty">{tr("前面的步骤失败或被停止，这一步未执行", "Skipped because an earlier step failed or the run was stopped")}</div>;
  }
  const result = stepRun.result;
  const errorBanner = stepRun.status === "failed" && stepRun.error
    ? <div className="pd-flow-error-banner">✕ {stepRun.error}</div>
    : null;
  if (result?.kind === "request") {
    return (
      <div className="pd-flow-detail">
        {errorBanner}
        {renderRequestResult(result, runKey)}
      </div>
    );
  }
  if (result?.kind === "script") {
    const tests = Object.entries(result.tests || {});
    const logs = result.logs || [];
    return (
      <div className="pd-flow-detail">
        {errorBanner}
        <div className="pd-scroll">
          {tests.length > 0 && (
            <div className="pd-response-sub">
              {tests.map(([name, passed]) => <Badge key={name} variant={passed ? "success" : "danger"}>{passed ? "✓" : "✕"} {name}</Badge>)}
            </div>
          )}
          {logs.length === 0 ? <div className="pd-empty">{tr("脚本没有输出", "No script output")}</div> : (
            <div className="pd-log-list">
              {logs.map((log, index) => (
                <div key={index} className={`pd-log ${log.level || "info"}`}>
                  <span className="pd-log-phase">{log.phase || "script"}</span>
                  <span className="pd-log-level">{String(log.level || "info").toUpperCase()}</span>
                  <code>{log.message}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  // delay step, or a step that failed before producing a result
  return (
    <div className="pd-flow-detail">
      {errorBanner}
      <div className="pd-empty pd-response-empty">
        {step?.type === "delay"
          ? tr(`已等待 ${formatDelay(step.ms)}`, `Slept ${formatDelay(step.ms)}`)
          : stepRun.status === "stopped" ? tr("已停止", "Stopped") : ""}
      </div>
    </div>
  );
}
