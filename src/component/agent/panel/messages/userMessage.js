import { IMAGE_REF_PATTERN, isBase64DataUrl } from "../../imageRefs";
import { parseImageDataUrl } from "./toolResults";

const IMAGE_DEREF_PATTERN = /^\|deRef:(img_[A-Za-z0-9_-]+)\|$/;
const IMAGE_FILE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function imageBlockToDataUrl(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image" && block.source?.type === "base64" && block.source.media_type && block.source.data) {
    return `data:${block.source.media_type};base64,${block.source.data}`;
  }
  if (block.type === "image_url" && isBase64DataUrl(block.image_url?.url)) {
    return block.image_url.url;
  }
  return null;
}

export function isImageFile(file) {
  if (!file) return false;
  return String(file.type || "").startsWith("image/") || IMAGE_FILE_EXT.test(String(file.name || ""));
}

export function getClipboardImageFiles(clipboardData) {
  const items = Array.from(clipboardData?.items || []);
  let imageFiles = items
    .filter(item => item.kind === "file" && (String(item.type || "").startsWith("image/") || item.type === ""))
    .map(item => item.getAsFile())
    .filter(isImageFile);

  const files = Array.from(clipboardData?.files || []);
  if (imageFiles.length === 0) {
    imageFiles = files.filter(isImageFile);
  }

  return imageFiles;
}

export async function imageFileToAttachmentItem(file) {
  const rawDataUrl = await blobToDataUrl(file);
  const optimizedDataUrl = await optimizeImageDataUrl(rawDataUrl);
  const parsed = parseImageDataUrl(optimizedDataUrl);
  if (!parsed) return null;
  return {
    id: `att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: "image",
    dataUrl: optimizedDataUrl,
    mediaType: parsed.mediaType,
    fileName: file.name
  };
}

export function resolveImageRefsInValue(value, refs) {
  if (typeof value === "string") {
    const imageRef = normalizeImageRefToken(value);
    if (!imageRef) return value;
    return refs.get(imageRef) || value;
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveImageRefsInValue(item, refs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveImageRefsInValue(child, refs)])
    );
  }

  return value;
}

export function normalizeImageRefToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // Keep the raw candidate when it is not URL encoded.
  }

  for (const candidate of candidates) {
    let normalized = candidate.trim();
    while (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
    const derefMatch = normalized.match(IMAGE_DEREF_PATTERN);
    if (derefMatch) return derefMatch[1];
    if (IMAGE_REF_PATTERN.test(normalized)) return normalized;
  }

  return "";
}

export function summarizeImageRefCache(sessionId, cache) {
  const refs = cache?.refs instanceof Map ? cache.refs : new Map();
  return {
    sessionId,
    count: refs.size,
    refs: Object.fromEntries(
      Array.from(refs.entries()).map(([ref, source]) => [ref, summarizeImageRefSource(source)])
    )
  };
}

export function summarizeImageRefSource(source) {
  const raw = String(source || "");
  const parsed = parseImageDataUrl(raw);
  return {
    kind: parsed ? "data-url" : raw ? "url" : "empty",
    mediaType: parsed?.mediaType || "",
    length: raw.length,
    preview: raw ? `${raw.slice(0, 80)}${raw.length > 80 ? "..." : ""}` : ""
  };
}
export function buildUserMessageContent(text, images, textFiles = [], imageRefs = []) {
  const content = [];

  const textParts = [];
  if (text && text.trim()) textParts.push(text.trim());
  for (const item of imageRefs) {
    if (!item?.ref) continue;
    textParts.push(`Attached image ref: ${item.ref}. For any tool argument that requires this image's base64 data URL, pass exactly "|deRef:${item.ref}|". Do not copy or rewrite the data URL.`);
  }
  if (textParts.length > 0) {
    content.push({ type: "text", text: textParts.join("\n\n") });
  }

  for (const f of textFiles) {
    console.log(`[DEBUG] 构建消息内容 - 文件: ${f.fileName}, 文本长度: ${f.text.length}, 前100字符:`, f.text.substring(0, 100));
    content.push({ type: "file", fileName: f.fileName, text: f.text });
  }

  for (const img of images) {
    const parsed = parseImageDataUrl(img.dataUrl);
    if (parsed) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: parsed.mediaType, data: parsed.data }
      });
    }
  }

  return content;
}

export async function optimizeImageDataUrl(dataUrl) {
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });

    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const width = Math.round(img.width * scale);
    const height = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", 0.7);
  } catch (e) {
    console.error("Image optimization failed:", e);
    return dataUrl;
  }
}

export async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
