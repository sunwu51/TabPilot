/* eslint-disable react/prop-types */
/* eslint-disable react-refresh/only-export-components */
import { useMemo, useState } from "react";
import { Button, Card } from "@sunwu51/camel-ui";

const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 4;

export function normalizeUserInputRequest(args = {}) {
  const rawQuestions = Array.isArray(args.questions) ? args.questions.slice(0, MAX_QUESTIONS) : [];
  if (rawQuestions.length === 0) return { error: "At least one question is required" };

  const seenIds = new Set();
  const questions = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const raw = rawQuestions[index] || {};
    const id = String(raw.id || `question_${index + 1}`).trim();
    const question = String(raw.question || "").trim();
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .slice(0, MAX_OPTIONS)
      .map(option => ({
        label: String(option?.label || "").trim(),
        description: String(option?.description || "").trim()
      }))
      .filter(option => option.label);
    if (!id || seenIds.has(id)) return { error: `Question id must be unique: ${id || "(empty)"}` };
    if (!question) return { error: `Question ${id} is missing question text` };
    if (options.length < 2) return { error: `Question ${id} must include at least two options` };
    seenIds.add(id);
    questions.push({
      id,
      header: String(raw.header || `问题 ${index + 1}`).trim() || `问题 ${index + 1}`,
      question,
      options
    });
  }
  return { questions };
}

export function UserInputRequestCard({ request, onSubmit, onCancel }) {
  const questions = useMemo(
    () => Array.isArray(request?.questions) ? request.questions : [],
    [request?.questions]
  );
  const [selections, setSelections] = useState({});
  const [otherValues, setOtherValues] = useState({});

  const answers = useMemo(() => Object.fromEntries(questions.map(question => {
    const selection = selections[question.id];
    const answer = selection === "__other__"
      ? String(otherValues[question.id] || "").trim()
      : String(selection || "").trim();
    return [question.id, answer];
  })), [otherValues, questions, selections]);
  const canSubmit = questions.length > 0 && questions.every(question => answers[question.id]);

  const selectOption = (questionId, value) => {
    setSelections(current => ({ ...current, [questionId]: value }));
  };

  return (
    <Card className="!p-2 !mb-1 user-input-request-card">
      <div className="user-input-request-title">需要你的选择</div>
      <div className="user-input-request-questions">
        {questions.map(question => (
          <fieldset key={question.id} className="user-input-request-question">
            <legend>{question.header}</legend>
            <div className="user-input-request-prompt">{question.question}</div>
            <div className="user-input-request-options">
              {question.options.map(option => (
                <button
                  type="button"
                  key={option.label}
                  className={`user-input-request-option ${selections[question.id] === option.label ? "is-selected" : ""}`}
                  onClick={() => selectOption(question.id, option.label)}
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
              <button
                type="button"
                className={`user-input-request-option ${selections[question.id] === "__other__" ? "is-selected" : ""}`}
                onClick={() => selectOption(question.id, "__other__")}
              >
                <span>其他</span>
                <small>输入自定义答案</small>
              </button>
            </div>
            {selections[question.id] === "__other__" && (
              <input
                type="text"
                className="user-input-request-other"
                value={otherValues[question.id] || ""}
                onChange={event => setOtherValues(current => ({
                  ...current,
                  [question.id]: event.target.value
                }))}
                placeholder="请输入你的答案"
                autoFocus
              />
            )}
          </fieldset>
        ))}
      </div>
      <div className="chat-input-actions" style={{ justifyContent: "flex-end", gap: "6px" }}>
        <Button className="!text-xs" onPress={onCancel}>取消</Button>
        <Button className="!text-xs" isDisabled={!canSubmit} onPress={() => onSubmit(answers)}>提交</Button>
      </div>
    </Card>
  );
}
