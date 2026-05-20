import { normalizeMessageImageRefs, isBase64DataUrl } from "../../imageRefs";
import { formatJsonFence, formatTextFence } from "../utils/scheduleStatus";
import { parseImageDataUrl, parseToolMessageContent } from "../messages/toolResults";
import { imageBlockToDataUrl } from "../messages/userMessage";

export function buildSessionExportMarkdown({ title, sessionId, messages }) {
  const imageRefMap = buildExportImageRefMap(messages);
  const sections = [
    `# ${title || "新会话"}`,
    "",
    `- 导出时间: ${new Date().toLocaleString()}`,
    `- 会话 ID: ${sessionId || ""}`,
    ""
  ];

  for (const msg of messages || []) {
    sections.push(...serializeExportMessage(msg, imageRefMap));
  }

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function serializeExportMessage(msg, imageRefMap = new Map()) {
  if (!msg || !msg.role) return [];

  if (msg.role === "user") {
    return serializeUserExportMessage(msg);
  }

  if (msg.role === "assistant") {
    return serializeAssistantExportMessage(msg, imageRefMap);
  }

  if (msg.role === "tool") {
    return [
      `## 工具结果${msg.tool_name ? ` · ${msg.tool_name}` : ""}`,
      "",
      formatToolResultForMarkdown(msg),
      ""
    ];
  }

  if (msg.role === "error") {
    return [
      "## 错误",
      "",
      formatJsonFence(msg.content ?? {}),
      ""
    ];
  }

  return [
    `## ${msg.role}`,
    "",
    formatUnknownContentForMarkdown(msg.content),
    ""
  ];
}

export function serializeUserExportMessage(msg) {
  return [
    "---",
    "",
    "## 用户",
    "",
    formatUserContentForMarkdown(msg.content),
    ""
  ];
}

export function formatUserContentForMarkdown(content) {
  if (typeof content === "string") return content.trim() || "_空内容_";
  if (!Array.isArray(content)) return formatUnknownContentForMarkdown(content);

  const parts = content
    .map(formatUserContentBlockForMarkdown)
    .filter(part => typeof part === "string" && part.trim().length > 0);

  return parts.length > 0 ? parts.join("\n\n") : "_空内容_";
}

export function formatUserContentBlockForMarkdown(block) {
  if (!block || typeof block !== "object") return "";

  if (block.type === "text") {
    return String(block.text ?? "").trim();
  }

  if (block.type === "file") {
    const fileName = String(block.fileName || block.name || "attachment.txt").trim();
    return [`### 附件 · ${fileName}`, "", formatTextFence(block.text ?? "")].join("\n");
  }

  const dataUrl = imageBlockToDataUrl(block);
  if (dataUrl) {
    const mediaType = parseImageDataUrl(dataUrl)?.mediaType || "image";
    return `![用户图片 · ${mediaType}](${dataUrl})`;
  }

  return formatJsonFence(block);
}

export function serializeAssistantExportMessage(msg, imageRefMap = new Map()) {
  const sections = [];

  if (typeof msg.content === "string" && msg.content.trim()) {
    sections.push("## 助手", "", replaceMarkdownImageDerefSources(msg.content.trim(), imageRefMap), "");
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block) continue;
      if (block.type === "text" && block.text) {
        sections.push("## 助手", "", replaceMarkdownImageDerefSources(String(block.text).trim(), imageRefMap), "");
      } else if (block.type === "tool_use") {
        sections.push(
          `## 工具调用${block.name ? ` · ${block.name}` : ""}`,
          "",
          formatJsonFence(block.input ?? {}),
          ""
        );
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall?.function?.name || toolCall?.name || "tool";
      let toolArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? toolCall?.args ?? {};
      if (typeof toolArgs === "string") {
        try {
          toolArgs = JSON.parse(toolArgs);
        } catch (error) {
          toolArgs = { raw: toolArgs };
        }
      }
      sections.push(
        `## 工具调用 · ${toolName}`,
        "",
        formatJsonFence(toolArgs),
        ""
      );
    }
  }

  if (sections.length === 0) {
    sections.push("## 助手", "", "_空内容_", "");
  }

  return sections;
}

export function buildExportImageRefMap(messages = []) {
  const refs = new Map();
  for (const msg of messages || []) {
    for (const item of normalizeMessageImageRefs(msg?.imageRefs)) {
      if (isBase64DataUrl(item.dataUrl) && !refs.has(item.ref)) {
        refs.set(item.ref, item.dataUrl);
      }
    }
  }
  return refs;
}

export function replaceMarkdownImageDerefSources(markdown, imageRefMap = new Map()) {
  if (typeof markdown !== "string" || !markdown.includes("|deRef:")) return markdown;
  return markdown.replace(/(!\[[^\]\n]*\]\()\|deRef:(img_[A-Za-z0-9_-]+)\|(\))/g, (match, prefix, ref, suffix) => {
    const dataUrl = imageRefMap.get(ref);
    return isBase64DataUrl(dataUrl) ? `${prefix}${dataUrl}${suffix}` : match;
  });
}

export function formatToolResultForMarkdown(msg) {
  const parsed = parseToolMessageContent(msg.content);
  const contentBlock = typeof parsed === "string"
    ? formatTextFence(parsed)
    : formatJsonFence(parsed ?? {});
  const displayImages = Array.isArray(msg.displayImages) && msg.displayImages.length > 0
    ? msg.displayImages.map(image => image?.url).filter(Boolean)
    : (msg.displayImageUrl ? [msg.displayImageUrl] : []);

  if (displayImages.length === 0) {
    return contentBlock;
  }

  return [
    contentBlock,
    "",
    ...displayImages.map((url, index) => `![工具图片${displayImages.length > 1 ? ` ${index + 1}` : ""}](${url})`)
  ].join("\n");
}

export function formatUnknownContentForMarkdown(content) {
  if (typeof content === "string") return content.trim() || "_空内容_";
  if (Array.isArray(content)) return formatJsonFence(content);
  if (content && typeof content === "object") return formatJsonFence(content);
  return "_空内容_";
}
export function downloadMarkdownFile(filename, markdown) {
  const safeFilename = String(filename || "session.md").trim() || "session.md";
  const blob = new Blob([String(markdown ?? "")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFilename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
    return { success: true, fileName: safeFilename, size: blob.size, source: "side-panel-blob" };
  } finally {
    anchor.remove();
    // Keep the blob URL alive long enough for Chromium to start consuming it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
