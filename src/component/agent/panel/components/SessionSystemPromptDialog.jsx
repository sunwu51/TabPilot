/* eslint-disable react/prop-types */
import { useRef, useState } from "react";
import { Button } from "@sunwu51/camel-ui";
import toast from "react-hot-toast";
import { useLocalizedDom } from "../../../../i18n";

const SYSTEM_PROMPT_PLACEHOLDER =
  "例如：你是一位情感大师，擅长共情、倾听和温柔地拆解亲密关系问题。回答时先复述用户感受，再给出具体可执行的沟通建议；避免评判，语气温暖、真诚、稳定。";

export function SessionSystemPromptDialogBody({ initialValue = "", initiallyApplyToNewSessions = false, onSave }) {
  const [draft, setDraft] = useState(initialValue || "");
  const [applyToNewSessions, setApplyToNewSessions] = useState(!!initiallyApplyToNewSessions);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef(null);
  const localizedRootRef = useLocalizedDom();

  function closeDialog() {
    const closeButton = rootRef.current?.closest(".dialog-backdrop")?.querySelector(".dialog-close-button");
    closeButton?.click();
  }

  async function handleSave() {
    setSaving(true);
    try {
      const saved = await onSave?.(draft, applyToNewSessions);
      if (saved !== false) closeDialog();
    } catch (error) {
      toast.error(`保存失败: ${error?.message || String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={(node) => {
      rootRef.current = node;
      localizedRootRef(node);
    }} className="system-prompt-dialog">
      <div>
        <div className="schedule-dialog-title">当前会话系统提示</div>
        <div className="schedule-dialog-subtitle">默认只影响当前会话，会作为额外 system prompt 注入。</div>
      </div>
      <textarea
        className="system-prompt-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={SYSTEM_PROMPT_PLACEHOLDER}
      />
      <label className="system-prompt-default-toggle">
        <input
          type="checkbox"
          checked={applyToNewSessions}
          onChange={(e) => setApplyToNewSessions(e.target.checked)}
        />
        <span>同时作为新会话的系统提示（最多只能有一个）</span>
      </label>
      <div className="schedule-dialog-actions">
        <Button
          className="!min-h-8 !px-3 !text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
          onPress={closeDialog}
          isDisabled={saving}
        >
          取消
        </Button>
        <Button
          className="!min-h-8 !px-3 !text-xs !whitespace-nowrap"
          onPress={handleSave}
          isDisabled={saving}
        >
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}
