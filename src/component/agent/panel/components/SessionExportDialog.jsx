/* eslint-disable react/prop-types */
import { Button, Input } from "@sunwu51/camel-ui";
import { useState } from "react";
import toast from "react-hot-toast";
import { loadSessionImageStore } from "../../../../api/agent/sessions";
import { buildSessionExportMarkdown, downloadMarkdownFile } from "../export/sessionExport";
import { copyTextToClipboard, shareMarkdown } from "../export/sessionShare";
import { useLocalizedDom, tr } from "../../../../i18n";

export function SessionExportDialogBody({ sessionId = "", title = "", messages = [] }) {
  const rootRef = useLocalizedDom();
  const [password, setPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const hasContent = !!sessionId && Array.isArray(messages) && messages.length > 0;

  async function buildMarkdownForAction(options = {}) {
    const imageStore = await loadSessionImageStore(sessionId);
    return buildSessionExportMarkdown({
      title: title || "新会话",
      sessionId,
      messages,
      imageStore,
      ...options
    });
  }

  async function handleExport() {
    if (!hasContent) {
      toast(tr("当前会话还没有可导出的内容", "This session has nothing to export yet"), { duration: 2500 });
      return;
    }

    setExporting(true);
    try {
      const exportMarkdown = await buildMarkdownForAction();
      const result = await downloadMarkdownFile(`${sessionId}.md`, exportMarkdown);
      if (result?.error) throw new Error(result.error);
      toast.success(tr(`已导出 ${sessionId}.md`, `Exported ${sessionId}.md`));
    } catch (error) {
      console.error("Failed to export session:", error);
      toast.error(tr(`导出失败: ${error?.message || String(error)}`, `Export failed: ${error?.message || String(error)}`));
    } finally {
      setExporting(false);
    }
  }

  async function handleShare() {
    if (!hasContent) {
      toast(tr("当前会话还没有可分享的内容", "This session has nothing to share yet"), { duration: 2500 });
      return;
    }

    setSharing(true);
    try {
      const shareMarkdownContent = await buildMarkdownForAction({ includeImages: false, collapseTools: true });
      const result = await shareMarkdown({
        markdown: shareMarkdownContent,
        password
      });
      const viewerUrl = String(result?.viewerUrl || result?.url || "").trim();
      if (!viewerUrl) throw new Error("分享结果里没有可用链接");
      const copied = await copyTextToClipboard(viewerUrl);
      toast.success(copied
        ? (password.trim() ? tr("分享链接已复制，请单独告知密码", "Share link copied. Send the password separately.") : tr("分享链接已复制", "Share link copied"))
        : tr(`分享成功：${viewerUrl}`, `Shared: ${viewerUrl}`));
    } catch (error) {
      console.error("Failed to share session:", error);
      toast.error(tr(`分享失败: ${error?.message || String(error)}`, `Share failed: ${error?.message || String(error)}`));
    } finally {
      setSharing(false);
    }
  }

  return (
    <div ref={rootRef} className="session-export-dialog">
      <div>
        <div className="schedule-dialog-title">导出当前会话</div>
        <div className="schedule-dialog-subtitle">导出文件保持原有 markdown 格式，分享链接支持可选密码。</div>
      </div>
      <div className="session-export-dialog-row">
        <Button
          className="!w-full"
          onPress={handleExport}
          isDisabled={!hasContent || exporting || sharing}
        >
          {exporting ? "导出中..." : "导出为文件"}
        </Button>
      </div>
      <div className="session-export-dialog-row session-export-dialog-share-row">
        <Input
          type="password"
          className="session-export-dialog-input"
          aria-label={tr("分享密码", "Share password")}
          value={password}
          onChange={setPassword}
          placeholder="设置密码，留空为无密码"
          isDisabled={!hasContent || exporting || sharing}
          autoComplete="new-password"
          showPasswordLabel={tr("显示密码", "Show password")}
          hidePasswordLabel={tr("隐藏密码", "Hide password")}
        />
        <Button
          className="!whitespace-nowrap"
          onPress={handleShare}
          isDisabled={!hasContent || exporting || sharing}
        >
          {sharing ? "分享中..." : "分享链接"}
        </Button>
      </div>
      <div className="schedule-dialog-subtitle">分享链接有效期为 90 天。</div>
    </div>
  );
}
