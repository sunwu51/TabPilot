/* global chrome */

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

const IMAGE_GENERATIONS_PATH = "/v1/images/generations";
const IMAGE_EDITS_PATH = "/v1/images/edits";
const IMAGE_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_DEREF_PATTERN = /^\|deRef:(img_[A-Za-z0-9_-]+)\|$/;
const IMAGE_REF_PATTERN = /^img_[A-Za-z0-9_-]+$/;

export function isImageApiConfigured(config = {}) {
  return !!String(config?.imageBaseUrl || "").trim() && !!String(config?.imageApiKey || "").trim();
}

export function resolveImageApiRequestUrl(baseUrl, endpoint) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";

  const segment = endpoint === "edits" ? "edits" : "generations";
  const defaultPath = endpoint === "edits" ? IMAGE_EDITS_PATH : IMAGE_GENERATIONS_PATH;

  try {
    const parsed = new URL(raw);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    if (!normalizedPath || normalizedPath === "/") {
      parsed.pathname = defaultPath;
    } else if (/\/images\/(generations|edits)$/i.test(normalizedPath)) {
      parsed.pathname = normalizedPath.replace(/\/images\/(generations|edits)$/i, `/images/${segment}`);
    } else if (/\/images$/i.test(normalizedPath)) {
      parsed.pathname = `${normalizedPath}/${segment}`;
    } else {
      parsed.pathname = `${normalizedPath}/images/${segment}`;
    }
    return parsed.toString();
  } catch {
    const withoutSlash = raw.replace(/\/+$/, "");
    if (/\/images\/(generations|edits)$/i.test(withoutSlash)) {
      return withoutSlash.replace(/\/images\/(generations|edits)$/i, `/images/${segment}`);
    }
    if (/\/images$/i.test(withoutSlash)) return `${withoutSlash}/${segment}`;
    return `${withoutSlash}${defaultPath}`;
  }
}

export async function executeImageGeneration(args = {}) {
  const config = await readImageApiConfig();
  const validationError = validateImageApiConfig(config);
  if (validationError) return validationError;

  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "prompt is required" };

  const body = buildImageRequestBody(args, config, { prompt });
  const url = resolveImageApiRequestUrl(config.imageBaseUrl, "generations");
  const result = await postImageJson(url, config.imageApiKey, body);
  if (result.error) return result;

  return buildImageToolResult(result.payload, {
    endpoint: "generations",
    model: body.model,
    prompt,
    outputFormat: body.output_format
  });
}

export async function executeImageEdit(args = {}) {
  const config = await readImageApiConfig();
  const validationError = validateImageApiConfig(config);
  if (validationError) return validationError;

  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "prompt is required" };

  const images = normalizeEditImages(args);
  if (images.length === 0) return { error: "image is required" };
  const body = buildImageRequestBody(args, config, { prompt });
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value != null && value !== "") form.append(key, String(value));
  }

  for (let i = 0; i < images.length; i++) {
    const file = await imageSourceToFile(images[i], `image-${i + 1}`);
    form.append("image[]", file, file.name || `image-${i + 1}.png`);
  }

  const mask = String(args.mask || "").trim();
  if (mask) {
    const maskFile = await imageSourceToFile(mask, "mask");
    form.append("mask", maskFile, maskFile.name || "mask.png");
  }

  const url = resolveImageApiRequestUrl(config.imageBaseUrl, "edits");
  const result = await postImageForm(url, config.imageApiKey, form);
  if (result.error) return result;

  return buildImageToolResult(result.payload, {
    endpoint: "edits",
    model: body.model,
    prompt,
    inputImageCount: images.length,
    hasMask: !!mask,
    outputFormat: body.output_format
  });
}

function normalizeEditImages(args = {}) {
  const primaryImage = String(args.image || "").trim();
  const imageArray = Array.isArray(args.images)
    ? args.images.map(item => String(item || "").trim()).filter(Boolean)
    : [];
  const additionalImages = Array.isArray(args.additional_images)
    ? args.additional_images.map(item => String(item || "").trim()).filter(Boolean)
    : [];

  const ordered = primaryImage
    ? [primaryImage, ...imageArray.filter(item => item !== primaryImage), ...additionalImages]
    : [...imageArray, ...additionalImages];
  const seen = new Set();
  return ordered.filter(item => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

async function readImageApiConfig() {
  const { llmConfig } = await chrome.storage.local.get({ llmConfig: {} });
  return {
    imageBaseUrl: String(llmConfig?.imageBaseUrl || "").trim(),
    imageApiKey: String(llmConfig?.imageApiKey || "").trim(),
    imageModel: String(llmConfig?.imageModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL
  };
}

function validateImageApiConfig(config) {
  if (!String(config?.imageBaseUrl || "").trim()) {
    return { error: "Image API URL is not configured" };
  }
  if (!String(config?.imageApiKey || "").trim()) {
    return { error: "Image API token is not configured" };
  }
  return null;
}

function buildImageRequestBody(args, config, requiredFields) {
  const model = String(args.model || config.imageModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const body = {
    model,
    prompt: requiredFields.prompt
  };

  addStringField(body, args, "size");
  addStringField(body, args, "quality");
  addStringField(body, args, "background");
  addOutputFormatField(body, args);
  addNumberField(body, args, "output_compression", { min: 0, max: 100, integer: true });
  addNumberField(body, args, "n", { min: 1, max: 10, integer: true });

  return body;
}

async function postImageJson(url, apiKey, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    return await readImageApiResponse(res);
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

async function postImageForm(url, apiKey, form) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
    return await readImageApiResponse(res);
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

async function readImageApiResponse(res) {
  const text = await res.text().catch(() => "");
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    return {
      error: `Image API returned HTTP ${res.status}`,
      status: res.status,
      detail: extractImageApiError(payload) || text || `HTTP ${res.status}`
    };
  }
  return { payload: payload ?? {} };
}

function buildImageToolResult(payload, meta) {
  const image = extractFirstImagePayload(payload);
  if (!image) {
    return {
      error: "Image API response did not contain an image",
      responseShape: summarizeImageResponseShape(payload)
    };
  }

  const result = {
    success: true,
    endpoint: meta.endpoint,
    model: meta.model,
    prompt: meta.prompt,
    imageCount: image.count
  };
  if (meta.inputImageCount) result.inputImageCount = meta.inputImageCount;
  if (meta.hasMask) result.maskApplied = true;
  if (image.revisedPrompt) result.revisedPrompt = image.revisedPrompt;

  if (image.b64) {
    const format = normalizeOutputFormat(meta.outputFormat);
    result.dataUrl = `data:image/${format};base64,${stripDataUrlPrefix(image.b64)}`;
    result.outputFormat = format;
    return result;
  }

  result.imageUrl = image.url;
  return result;
}

function extractFirstImagePayload(payload) {
  const candidates = [];
  if (Array.isArray(payload?.data)) candidates.push(...payload.data);
  if (Array.isArray(payload?.images)) candidates.push(...payload.images);
  if (payload?.image) candidates.push(payload.image);
  if (payload?.b64_json || payload?.url) candidates.push(payload);

  for (const candidate of candidates) {
    const b64 = findFirstString(
      candidate?.b64_json,
      candidate?.base64,
      candidate?.image_base64,
      candidate?.data
    );
    const url = findFirstString(candidate?.url, candidate?.image_url);
    if (b64 || url) {
      return {
        b64,
        url,
        revisedPrompt: findFirstString(candidate?.revised_prompt, candidate?.revisedPrompt),
        count: Math.max(1, candidates.length)
      };
    }
  }

  return null;
}

async function imageSourceToFile(source, fallbackName) {
  const raw = String(source || "").trim();
  if (!raw) throw new Error(`${fallbackName} is empty`);

  if (/^data:[^;]+;base64,/i.test(raw)) {
    const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) throw new Error(`Invalid data URL for ${fallbackName}`);
    const [, mediaType, base64Data] = match;
    const bytes = base64ToUint8Array(base64Data);
    return blobToNamedFile(new Blob([bytes], { type: mediaType }), `${fallbackName}.${extensionFromMediaType(mediaType)}`);
  }

  if (/^https?:\/\//i.test(raw)) {
    const res = await fetch(raw);
    if (!res.ok) throw new Error(`Failed to fetch image URL for ${fallbackName}: HTTP ${res.status}`);
    const blob = await res.blob();
    return blobToNamedFile(blob, `${fallbackName}.${extensionFromMediaType(blob.type || "image/png")}`);
  }

  const unresolvedRef = normalizeImageRefToken(raw);
  if (unresolvedRef) {
    throw new Error(`${fallbackName} ref ${unresolvedRef} was not resolved before image tool execution`);
  }
  if (raw.includes("|deRef:")) {
    throw new Error(`${fallbackName} contains an unresolved image ref`);
  }

  throw new Error(`${fallbackName} must be a data URL or http(s) URL`);
}

function normalizeImageRefToken(value) {
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

function blobToNamedFile(blob, name) {
  if (typeof File === "function") {
    return new File([blob], name, { type: blob.type || "application/octet-stream" });
  }
  blob.name = name;
  return blob;
}

function base64ToUint8Array(base64Data) {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stripDataUrlPrefix(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^data:[^;]+;base64,(.+)$/i);
  return match ? match[1] : raw;
}

function normalizeOutputFormat(value) {
  const raw = String(value || "").trim().toLowerCase();
  return IMAGE_OUTPUT_FORMATS.has(raw) ? raw : "png";
}

function addStringField(body, source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return;
  const value = String(source[key] || "").trim();
  if (value) body[key] = value;
}

function addOutputFormatField(body, source) {
  if (!Object.prototype.hasOwnProperty.call(source, "output_format")) return;
  const value = normalizeOutputFormat(source.output_format);
  if (value) body.output_format = value;
}

function addNumberField(body, source, key, { min, max, integer = false }) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return;
  let value = Number(source[key]);
  if (!Number.isFinite(value)) return;
  value = Math.min(max, Math.max(min, value));
  body[key] = integer ? Math.round(value) : value;
}

function extensionFromMediaType(mediaType) {
  const normalized = String(mediaType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}

function extractImageApiError(payload) {
  if (!payload || typeof payload !== "object") return "";
  return findFirstString(
    payload?.error?.message,
    payload?.error,
    payload?.message,
    payload?.detail
  );
}

function summarizeImageResponseShape(payload) {
  if (!payload || typeof payload !== "object") return typeof payload;
  return {
    keys: Object.keys(payload).slice(0, 12),
    dataLength: Array.isArray(payload.data) ? payload.data.length : undefined,
    imagesLength: Array.isArray(payload.images) ? payload.images.length : undefined
  };
}

function findFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
