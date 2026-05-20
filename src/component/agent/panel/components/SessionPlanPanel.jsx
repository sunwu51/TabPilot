/* eslint-disable react/prop-types */
import { useState } from "react";
import { Button, Card } from "@sunwu51/camel-ui";
import { formatPlanStatus, getPlanStepIcon } from "../utils/sessionPlans";

export function SessionPlanPanel({ plan, collapsed = false, onToggleCollapsed }) {
  if (!plan) return null;
  const steps = plan.steps || [];
  const completedCount = steps.filter(step => step.status === "completed" || step.status === "skipped").length;
  const currentStep = steps.find(step => step.status === "in_progress") || steps.find(step => step.status === "blocked");
  return (
    <div className={`session-plan-panel session-plan-${plan.status || "draft"} ${collapsed ? "session-plan-collapsed" : ""}`}>
      <button
        type="button"
        className="session-plan-header"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? "展开计划" : "收起计划"}
      >
        <span className="session-plan-title">📋 {plan.title || "执行计划"}</span>
        <span className="session-plan-summary">
          {completedCount}/{steps.length}
          {currentStep ? ` · ${currentStep.title}` : ""}
        </span>
        <span className="session-plan-status">{formatPlanStatus(plan.status)}</span>
        <span className="session-plan-toggle">{collapsed ? "展开" : "收起"}</span>
      </button>
      {!collapsed && (
        <ol className="session-plan-steps">
          {steps.map((step, index) => (
            <li key={step.id || index} className={`session-plan-step session-plan-step-${step.status || "pending"}`}>
              <span className="session-plan-step-icon">{getPlanStepIcon(step.status)}</span>
              <span className="session-plan-step-body">
                <span className="session-plan-step-title">{step.title}</span>
                {step.note && <span className="session-plan-step-note">{step.note}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function PlanApprovalCard({ plan, onResolve }) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <Card className="!p-2 !mb-1 plan-approval-card">
      <div className="plan-approval-title">执行计划待确认</div>
      <div className="plan-approval-plan-title">{plan?.title || "执行计划"}</div>
      <ol className="plan-approval-steps">
        {(plan?.steps || []).map((step, index) => (
          <li key={step.id || index}>
            <span className="plan-approval-step-title">{step.title}</span>
            {step.description && <span className="plan-approval-step-desc">{step.description}</span>}
          </li>
        ))}
      </ol>
      {showFeedback && (
        <textarea
          className="plan-approval-feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="你希望怎么修改这个计划？"
          rows={2}
          autoFocus
        />
      )}
      <div className="chat-input-actions" style={{ justifyContent: "flex-end", gap: "6px" }}>
        {showFeedback ? (
          <>
            <Button className="!text-xs" onPress={() => setShowFeedback(false)}>返回</Button>
            <Button className="!text-xs" onPress={() => onResolve(false, feedback)}>提交修改意见</Button>
          </>
        ) : (
          <>
            <Button className="!text-xs" onPress={() => setShowFeedback(true)}>不 OK，补充要求</Button>
            <Button className="!text-xs" onPress={() => onResolve(true)}>OK，开始实施</Button>
          </>
        )}
      </div>
    </Card>
  );
}

