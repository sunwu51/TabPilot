import { isBase64DataUrl, normalizeImageRefSource } from "../../imageRefs";
export function buildToolResultMessages(toolResults, targetSessionId, registerImageDataUrl) {
  return toolResults.map(tr => buildDisplayToolResultMessage(tr, targetSessionId, registerImageDataUrl));
}

export function buildLlmErrorDisplayMessage(error) {
  const code = error?.code || "LLM_ERROR";
  const message = error?.message || "LLM 请求失败";
  const failures = Array.isArray(error?.failures) ? error.failures : [];
  return {
    role: "error",
    content: {
      code,
      message,
      status: error?.status || null,
      attempts: Number(error?.attempts) || failures.length || 1,
      maxAttempts: Number(error?.maxAttempts) || failures.length || 1,
      apiType: error?.apiType || "",
      failures,
      detail: error?.detail || null
    }
  };
}

export function stampLastUserDuration(messages) {
  const now = Date.now();
  const updated = [...messages];
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === "user" && typeof updated[i].sentAt === "number") {
      updated[i] = { ...updated[i], durationMs: now - updated[i].sentAt };
      break;
    }
  }
  return updated;
}

export function buildDisplayToolResultMessage(toolResult, targetSessionId, registerImageDataUrl) {
  const displayImages = collectToolResultDisplayImages(toolResult?.result);
  const primaryImage = displayImages[0] || null;
  const parsedImage = parseImageDataUrl(primaryImage?.url);
  const imageRefs = [];
  const refsByUrl = new Map();
  if (targetSessionId && typeof registerImageDataUrl === "function") {
    for (const image of displayImages) {
      if (!isBase64DataUrl(image.url)) continue;
      const ref = registerImageDataUrl(targetSessionId, image.url);
      if (ref) {
        imageRefs.push({ ref, dataUrl: image.url, mediaType: image.mediaType, role: "tool_result" });
        refsByUrl.set(image.url, ref);
      }
    }
  }
  const summary = summarizeToolResult(toolResult.result, imageRefs);
  const serializedContent = serializeToolResult(summary);
  const message = {
    role: "tool",
    tool_call_id: toolResult.id,
    tool_name: toolResult.name,
    content: serializedContent,
    displayImageUrl: primaryImage?.url || undefined,
    ...(primaryImage?.url && refsByUrl.get(primaryImage.url) ? { displayImageRef: refsByUrl.get(primaryImage.url) } : {}),
    displayImages: displayImages.length > 0
      ? displayImages.map(image => ({
        ...image,
        ...(refsByUrl.get(image.url) ? { ref: refsByUrl.get(image.url) } : {})
      }))
      : undefined,
    displayImageMediaType: parsedImage?.mediaType,
    durationMs: typeof toolResult.durationMs === "number" ? toolResult.durationMs : undefined,
  };
  if (imageRefs.length > 0) {
    message.imageRefs = imageRefs;
  }
  return message;
}

export function serializeToolResult(summary) {
  const json = JSON.stringify(summary);
  if (typeof json === "string") return json;
  return JSON.stringify(normalizeToolSummary(summary));
}

export function summarizeToolResult(result, imageRefs = []) {
  if (!result || typeof result !== "object") return result;

  const summary = { ...result };
  if (typeof summary.dataUrl === "string" && summary.dataUrl.startsWith("data:")) {
    delete summary.dataUrl;
    summary.imageOmittedFromTextContext = true;
  }
  if (imageRefs.length > 0) {
    summary.imageRefs = imageRefs.map(({ ref }) => ref);
    summary.imageRefInstruction = imageRefs
      .map(({ ref }) => `Tool returned an image ref: ${ref}. To preview it for the user, write Markdown exactly as ![image](|deRef:${ref}|). For later tool calls requiring this image's base64 data URL, pass exactly "|deRef:${ref}|". Do not copy or rewrite the data URL.`)
      .join("\n");
  }
  if (Array.isArray(summary.images)) {
    summary.images = summary.images.map(image => {
      if (!image || typeof image !== "object") return image;
      if (typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:")) {
        const rest = { ...image };
        delete rest.dataUrl;
        return { ...rest, imageOmittedFromTextContext: true };
      }
      return image;
    });
  }

  return summary;
}

export function collectToolResultDisplayImages(result) {
  const images = [];
  const pushImage = (source, options = {}) => {
    const url = normalizeImageRefSource(source);
    if (!url) return;
    if (!shouldDisplayToolResultImage(url, options)) return;
    const parsed = parseImageDataUrl(url);
    images.push({
      url,
      mediaType: parsed?.mediaType,
      kind: parsed ? "data-url" : "url"
    });
  };

  if (Array.isArray(result?.images)) {
    for (const image of result.images) {
      pushImage(image?.dataUrl || image?.imageUrl || image?.url, { explicitImageField: true });
    }
  }
  pushImage(result?.dataUrl, { explicitImageField: true });
  pushImage(result?.imageUrl, { explicitImageField: true });
  pushImage(result?.url, { explicitImageField: false });

  const seen = new Set();
  return images.filter(image => {
    if (!image?.url || seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  });
}

export function shouldDisplayToolResultImage(url, { explicitImageField = false } = {}) {
  if (!url) return false;
  if (isBase64DataUrl(url)) return true;
  if (/^(blob:|chrome-extension:\/\/)/i.test(url)) return explicitImageField;
  if (/^https?:\/\//i.test(url)) {
    return explicitImageField || isLikelyImageUrl(url);
  }
  return false;
}

export function isLikelyImageUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(png|jpe?g|gif|webp|bmp|avif|svg)(?:$|[?#])/i.test(parsed.pathname);
  } catch {
    return /\.(png|jpe?g|gif|webp|bmp|avif|svg)(?:$|[?#])/i.test(String(url || ""));
  }
}
export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

export function parseToolMessageContent(content) {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch (e) {
    return content;
  }
}

export function normalizeToolSummary(summary) {
  if (summary && typeof summary === "object") return summary;
  return { result: summary == null ? "" : String(summary) };
}

export function buildAnthropicToolResultContentFromMessage(msg, options = {}) {
  const summary = normalizeToolSummary(parseToolMessageContent(msg.content));
  const parsedImages = getToolResultParsedImages(msg);
  if (parsedImages.length === 0 || !supportsToolImageInput(options)) {
    return typeof summary === "string" ? summary : JSON.stringify(summary);
  }

  return [
    {
      type: "text",
      text: JSON.stringify({ ...summary, imageAttachedToToolResult: true })
    },
    ...parsedImages.map(parsedImage => ({
      type: "image",
      source: {
        type: "base64",
        media_type: parsedImage.mediaType,
        data: parsedImage.data
      }
    }))
  ];
}

export function buildOpenAIToolResultContent(msg) {
  const summary = normalizeToolSummary(parseToolMessageContent(msg.content));
  return typeof summary === "string" ? summary : JSON.stringify(summary);
}

export function buildOpenAIToolResultImageUserMessage(msg, options = {}) {
  const parsedImages = getToolResultParsedImages(msg);
  if (parsedImages.length === 0 || !supportsToolImageInput(options)) return null;

  const toolName = msg.tool_name || "unknown tool";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `The following image${parsedImages.length > 1 ? "s are" : " is"} from the previous ${toolName} tool result.`
      },
      ...parsedImages.map(parsedImage => ({
        type: "image_url",
        image_url: {
          url: parsedImage.url,
          detail: "low"
        }
      }))
    ]
  };
}

export function getToolResultParsedImages(msg) {
  const sources = Array.isArray(msg?.displayImages) && msg.displayImages.length > 0
    ? msg.displayImages.map(image => image?.url)
    : [msg?.displayImageUrl];
  return sources
    .map(url => ({ url: normalizeImageRefSource(url), parsed: parseImageDataUrl(normalizeImageRefSource(url)) }))
    .filter(item => item.url && item.parsed)
    .map(item => ({ url: item.url, ...item.parsed }));
}

export function supportsToolImageInput(options = {}) {
  if (options.supportsImageInput === false) return false;
  if (Object.prototype.hasOwnProperty.call(options, "supportsToolImageInput")) {
    return options.supportsToolImageInput === true;
  }
  return true;
}

// ==================== User Image Input Helpers ====================
