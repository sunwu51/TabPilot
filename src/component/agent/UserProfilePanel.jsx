import { Dialog, Switch } from "@sunwu51/camel-ui";
import { useState, useCallback, useEffect } from "react";
import {
  getProfileSummary,
  analyzeRecentHistory,
  isProfileEnabled,
  setProfileEnabled,
} from "../../api/userProfile";
import toast from "react-hot-toast";

export default function UserProfilePanel() {
  const [summary, setSummary] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const loadData = useCallback(async () => {
    const [s, en] = await Promise.all([getProfileSummary(), isProfileEnabled()]);
    setSummary(s);
    setEnabled(en);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const updated = await analyzeRecentHistory();
      if (!updated) toast("无浏览记录或未配置 LLM", { duration: 2500 });
    } catch (e) {
      console.error("[UserProfile] analyze error:", e);
      toast.error("分析失败：" + (e?.message || String(e)));
    }
    await loadData();
    setAnalyzing(false);
  }

  async function handleToggle(next) {
    await setProfileEnabled(next);
    setEnabled(next);
    toast(next ? "画像注入已开启" : "画像注入已关闭", { duration: 2000 });
  }

  return (
    <Dialog
      trigger={
        <button className="chat-toolbar-btn" onClick={loadData} title="画像">
          <span className="chat-toolbar-icon">👤</span>
          <span className="chat-toolbar-full-text">画像</span>
        </button>
      }
    >
      <div
        style={{
          width: "min(720px, calc(100vw - 32px))",
          maxWidth: "100%",
          maxHeight: "70vh",
          overflowY: "auto",
          overflowX: "hidden",
          paddingRight: "4px",
          boxSizing: "border-box",
        }}
      >
        {/* Header + analyze button + toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div className="text-sm font-bold text-gray-500">浏览偏好画像</div>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              style={{
                fontSize: "11px",
                color: "#6b7280",
                background: "none",
                border: "none",
                cursor: analyzing ? "default" : "pointer",
                padding: "0 4px",
                opacity: analyzing ? 0.5 : 1,
              }}
              title="分析近 48h 浏览记录并更新画像"
            >
              {analyzing ? "分析中…" : "↻ 立即分析"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Switch
              isSelected={enabled}
              onChange={handleToggle}
              round
              aria-label={enabled ? "关闭画像注入" : "开启画像注入"}
              className="!text-xs"
              style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}
            >
              <span className="text-xs text-gray-500" style={{ display: "inline-flex", alignItems: "center", minHeight: "24px" }}>
                {enabled ? "已开启" : "已关闭"}
              </span>
            </Switch>
          </div>
        </div>

        {!enabled && (
          <div className="text-xs text-gray-400 mb-4">画像注入已关闭，对话不会包含画像信息。已有画像数据仍保留。</div>
        )}

        {/* Profile summary */}
        <div className="text-xs font-semibold text-gray-500 mb-1">当前画像</div>
        <div
          style={{
            padding: "10px 12px",
            border: "1px solid #e5e7eb",
            borderRadius: "6px",
            background: "#f9fafb",
            fontSize: "12px",
            lineHeight: "1.6",
            color: summary ? "#374151" : "#9ca3af",
            overflowY: "auto",
            maxHeight: "200px",
          }}
        >
          {summary || "暂无画像。点击「↻ 立即分析」分析近 48h 浏览记录生成（需要配置 LLM）。"}
        </div>
      </div>
    </Dialog>
  );
}
