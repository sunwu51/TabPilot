export const IMAGE_REF_PATTERN = /^img_[A-Za-z0-9_-]+$/;

export function normalizeImageRefSource(source) {
  const raw = String(source || "").trim();
  if (!raw) return "";
  if (isBase64DataUrl(raw)) return raw;
  if (/^(https?:\/\/|blob:|chrome-extension:\/\/)/i.test(raw)) return raw;

  try {
    const baseUrl = typeof window !== "undefined" && window.location?.href
      ? window.location.href
      : "http://localhost/";
    const resolved = new URL(raw, baseUrl);
    if (["http:", "https:", "blob:", "chrome-extension:"].includes(resolved.protocol)) {
      return resolved.href;
    }
  } catch {
    return "";
  }

  return "";
}

export function normalizeMessageImageRefs(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      ...item,
      ref: String(item?.ref || "").trim(),
      dataUrl: normalizeImageRefSource(item?.dataUrl || item?.source || item?.url)
    }))
    .filter(item => IMAGE_REF_PATTERN.test(item.ref) && item.dataUrl);
}

export function mergeKnownImageRefsIntoMessages(messages = [], cache = {}) {
  if (!Array.isArray(messages) || !(cache?.refs instanceof Map)) return messages;
  let changed = false;
  const nextMessages = messages.map(message => {
    const next = mergeKnownImageRefsIntoMessage(message, cache);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? nextMessages : messages;
}

function mergeKnownImageRefsIntoMessage(message, cache) {
  if (!message || typeof message !== "object") return message;

  const additions = [];
  for (const ref of collectImageRefsFromMessage(message)) {
    const dataUrl = cache.refs.get(ref);
    if (dataUrl) additions.push({ ref, dataUrl });
  }

  const displayImageUrl = normalizeImageRefSource(message.displayImageUrl);
  if (displayImageUrl) {
    const displayRef = cache.byDataUrl?.get(displayImageUrl) || extractPreferredImageRefFromToolMessage(message);
    if (displayRef && cache.refs.get(displayRef) === displayImageUrl) {
      additions.push({ ref: displayRef, dataUrl: displayImageUrl, role: "tool_result" });
    }
  }

  if (additions.length === 0 && !Array.isArray(message.imageRefs)) return message;

  const existingRefs = normalizeMessageImageRefs(message.imageRefs);
  const mergedRefs = mergeMessageImageRefs([...existingRefs, ...additions]);
  if (sameMessageImageRefs(existingRefs, mergedRefs)) return message;
  return mergedRefs.length > 0
    ? { ...message, imageRefs: mergedRefs }
    : message;
}

function mergeMessageImageRefs(items = []) {
  const refsById = new Map();
  for (const item of normalizeMessageImageRefs(items)) {
    if (!refsById.has(item.ref)) refsById.set(item.ref, item);
  }
  return Array.from(refsById.values());
}

function sameMessageImageRefs(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((item, index) =>
    item.ref === b[index]?.ref &&
    item.dataUrl === b[index]?.dataUrl &&
    item.role === b[index]?.role
  );
}

export function collectReservedImageRefsFromMessages(messages = []) {
  const refs = new Set();
  if (!Array.isArray(messages)) return refs;
  for (const message of messages) {
    for (const ref of collectImageRefsFromMessage(message)) refs.add(ref);
  }
  return refs;
}

function collectImageRefsFromMessage(message) {
  const refs = new Set();
  if (!message || typeof message !== "object") return refs;

  if (Array.isArray(message.imageRefs)) {
    for (const item of message.imageRefs) {
      const ref = String(item?.ref || "").trim();
      if (IMAGE_REF_PATTERN.test(ref)) refs.add(ref);
    }
  }

  collectImageRefsFromMessageContent(message.content, refs);
  collectImageRefsFromText(message.displayContent, refs);

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      collectImageRefsFromText(toolCall?.function?.arguments, refs);
      collectImageRefsFromPlainValue(toolCall?.args, refs);
      collectImageRefsFromPlainValue(toolCall?.arguments, refs);
    }
  }

  return refs;
}

function collectImageRefsFromMessageContent(content, refs) {
  if (typeof content === "string") {
    collectImageRefsFromText(content, refs);
    return;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" || block.type === "file") {
        collectImageRefsFromText(block.text, refs);
      } else if (block.type === "tool_use") {
        collectImageRefsFromPlainValue(block.input, refs);
      }
    }
    return;
  }

  collectImageRefsFromPlainValue(content, refs);
}

function collectImageRefsFromPlainValue(value, refs, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    collectImageRefsFromText(value, refs);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageRefsFromPlainValue(item, refs, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (isImageDataFieldName(key) && typeof child === "string") continue;
    collectImageRefsFromPlainValue(child, refs, depth + 1);
  }
}

function collectImageRefsFromText(value, refs) {
  if (typeof value !== "string" || !value) return;
  const text = value.trim();
  if (!text || /^data:[^;]+;base64,/i.test(text)) return;
  const matches = text.match(/\bimg_[A-Za-z0-9_-]+\b/g);
  if (!matches) return;
  for (const ref of matches) {
    if (IMAGE_REF_PATTERN.test(ref)) refs.add(ref);
  }
}

function isImageDataFieldName(key) {
  return /^(data|dataUrl|displayImageUrl|imageUrl|url|source)$/i.test(String(key || ""));
}

export function extractPreferredImageRefFromToolMessage(message) {
  if (!message || typeof message !== "object") return "";

  const displayImageUrl = normalizeImageRefSource(message.displayImageUrl);
  if (displayImageUrl && Array.isArray(message.imageRefs)) {
    const match = normalizeMessageImageRefs(message.imageRefs).find(item => item.dataUrl === displayImageUrl);
    if (match?.ref) return match.ref;
  }

  const refs = extractImageRefsFromToolResultContent(message.content);
  return refs.length === 1 ? refs[0] : "";
}

function extractImageRefsFromToolResultContent(content) {
  const refs = new Set();
  const parsed = parseToolMessageContent(content);
  if (parsed && typeof parsed === "object") {
    collectImageRefsFromToolResultRefs(parsed.imageRefs, refs);
    collectImageRefsFromToolResultRefs(parsed.image_ref, refs);
    collectImageRefsFromToolResultRefs(parsed.imageRef, refs);
    collectImageRefsFromText(parsed.imageRefInstruction, refs);
    collectImageRefsFromText(parsed.imageRefInstructions, refs);
  } else {
    collectImageRefsFromText(parsed, refs);
  }
  return Array.from(refs);
}

function collectImageRefsFromToolResultRefs(value, refs) {
  if (typeof value === "string") {
    collectImageRefsFromText(value, refs);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") collectImageRefsFromText(item, refs);
    else if (item && typeof item === "object") collectImageRefsFromText(item.ref, refs);
  }
}

export function allocateGeneratedImageRef(cache) {
  if (!cache || typeof cache !== "object") return "";
  if (!Number.isFinite(cache.nextIndex) || cache.nextIndex < 1) cache.nextIndex = 1;
  for (let attempts = 0; attempts < 100000; attempts++) {
    const ref = `img_${cache.nextIndex}`;
    cache.nextIndex += 1;
    if (cache.refs?.has(ref)) continue;
    if (cache.reservedRefs?.has(ref)) continue;
    return ref;
  }
  return `img_${Date.now()}`;
}

export function isBase64DataUrl(dataUrl) {
  return typeof dataUrl === "string" && /^data:[^;]+;base64,/.test(dataUrl);
}

export function replaceBase64ImageDataUrlsWithRefs(value, registerImageDataUrl) {
  const images = [];
  const imagesByRef = new Map();
  const seen = new WeakMap();

  const replace = (current, depth = 0) => {
    if (typeof current === "string") {
      if (!/^data:image\/[^;]+;base64,/i.test(current)) return current;
      const ref = registerImageDataUrl(current);
      if (!ref) return current;
      if (!imagesByRef.has(ref)) {
        const mediaType = current.slice("data:".length, current.indexOf(";base64,"));
        const image = { ref, dataUrl: current, mediaType };
        imagesByRef.set(ref, image);
        images.push(image);
      }
      return `|deRef:${ref}|`;
    }
    if (current == null || typeof current !== "object" || depth >= 12) return current;
    if (seen.has(current)) return seen.get(current);

    const next = Array.isArray(current) ? [] : {};
    seen.set(current, next);
    if (Array.isArray(current)) {
      for (const item of current) next.push(replace(item, depth + 1));
    } else {
      for (const [key, child] of Object.entries(current)) {
        next[key] = replace(child, depth + 1);
      }
    }
    return next;
  };

  return { value: replace(value), images };
}

function parseToolMessageContent(content) {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}
