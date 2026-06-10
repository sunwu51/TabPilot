/* global chrome */

import { isConfiguredImageProfile, resolveActiveImageConfig } from "../../core/modelProfiles";
import { ensureSettingsMigrated } from "../../../settings/migrations";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const IMAGE_API_PROTOCOLS = {
  GENERATE: "generate",
  CHAT_COMPLETIONS: "chat_completions"
};

const IMAGE_GENERATIONS_PATH = "/v1/images/generations";
const IMAGE_EDITS_PATH = "/v1/images/edits";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const IMAGE_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_DEREF_PATTERN = /^\|deRef:(img_[A-Za-z0-9_-]+)\|$/;
const IMAGE_REF_PATTERN = /^img_[A-Za-z0-9_-]+$/;

export function isImageApiConfigured(config = {}) {
  const activeConfig = resolveActiveImageConfig(config);
  if (activeConfig.error) return false;
  return isConfiguredImageProfile(activeConfig);
}

export function resolveImageApiRequestUrl(baseUrl, endpoint) {
  if (endpoint === "chat_completions") {
    return resolveChatCompletionsRequestUrl(baseUrl);
  }

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

export function normalizeImageApiProtocol(value) {
  return value === IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS
    ? IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS
    : IMAGE_API_PROTOCOLS.GENERATE;
}

export async function executeImageGeneration(args = {}) {
  const config = await readImageApiConfig(args);
  if (config.error) return { error: config.error };
  const validationError = validateImageApiConfig(config);
  if (validationError) return validationError;

  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "prompt is required" };

  if (config.imageApiProtocol === IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS) {
    return executeChatCompletionsImageGeneration(args, config, { prompt });
  }

  const body = buildImageRequestBody(args, config, { prompt });
  const url = resolveImageApiRequestUrl(config.imageBaseUrl, "generations");
  const result = await postImageJson(url, config.imageApiKey, body);
  if (result.error) return result;

  return buildImageToolResult(result.payload, {
    endpoint: "generations",
    model: body.model,
    imageModelId: config.imageModelId,
    imageModelName: config.imageModelName,
    prompt,
    outputFormat: body.output_format
  });
}

export async function executeImageEdit(args = {}) {
  const config = await readImageApiConfig(args);
  if (config.error) return { error: config.error };
  const validationError = validateImageApiConfig(config);
  if (validationError) return validationError;

  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "prompt is required" };

  const images = normalizeEditImages(args);
  if (images.length === 0) return { error: "image is required" };

  if (config.imageApiProtocol === IMAGE_API_PROTOCOLS.CHAT_COMPLETIONS) {
    return executeChatCompletionsImageEdit(args, config, { prompt, images });
  }

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
    imageModelId: config.imageModelId,
    imageModelName: config.imageModelName,
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

async function readImageApiConfig(args = {}) {
  await ensureSettingsMigrated();
  const { llmConfig } = await chrome.storage.local.get({ llmConfig: {} });
  const config = resolveActiveImageConfig(llmConfig, args.image_model_id);
  if (config.error) return { error: config.error };
  const selectedProfile = config?.selectedImageProfile || null;
  const imageModel = String(config?.imageModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  return {
    imageBaseUrl: String(config?.imageBaseUrl || "").trim(),
    imageApiKey: String(config?.imageApiKey || "").trim(),
    imageModel,
    imageModelId: String(selectedProfile?.id || config?.activeImageModelId || "").trim(),
    imageModelName: imageModel,
    imageApiProtocol: normalizeImageApiProtocol(config?.imageApiProtocol),
    imageModels: config?.imageModels || [],
    activeImageModelId: config?.activeImageModelId || ""
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
  const model = String(config.imageModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
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

async function executeChatCompletionsImageGeneration(args, config, { prompt }) {
  const body = buildChatCompletionsImageRequestBody(args, config, {
    prompt,
    images: []
  });
  const url = resolveImageApiRequestUrl(config.imageBaseUrl, "chat_completions");
  const result = await postImageJson(url, config.imageApiKey, body);
  if (result.error) return result;

  return buildImageToolResult(result.payload, {
    endpoint: "chat_completions",
    model: body.model,
    imageModelId: config.imageModelId,
    imageModelName: config.imageModelName,
    prompt,
    outputFormat: args.output_format
  });
}

async function executeChatCompletionsImageEdit(args, config, { prompt, images }) {
  const mask = String(args.mask || "").trim();
  if (mask) {
    return { error: "mask is not supported by the chat/completions image protocol" };
  }

  const contentImages = [];
  for (let i = 0; i < images.length; i++) {
    contentImages.push(await imageSourceToChatImageContent(images[i], `image-${i + 1}`));
  }
  const body = buildChatCompletionsImageRequestBody(args, config, {
    prompt,
    images: contentImages
  });
  const url = resolveImageApiRequestUrl(config.imageBaseUrl, "chat_completions");
  const result = await postImageJson(url, config.imageApiKey, body);
  if (result.error) return result;

  return buildImageToolResult(result.payload, {
    endpoint: "chat_completions",
    model: body.model,
    imageModelId: config.imageModelId,
    imageModelName: config.imageModelName,
    prompt,
    inputImageCount: images.length,
    outputFormat: args.output_format
  });
}

function buildChatCompletionsImageRequestBody(args, config, { prompt, images = [] }) {
  const model = String(config.imageModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const userContent = [
    { type: "text", text: prompt },
    ...images
  ];
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: userContent
      }
    ],
    modalities: ["image", "text"]
  };

  addStringField(body, args, "size");
  addStringField(body, args, "quality");
  addNumberField(body, args, "n", { min: 1, max: 10, integer: true });

  return body;
}

async function imageSourceToChatImageContent(source, fallbackName) {
  const raw = String(source || "").trim();
  if (!raw) throw new Error(`${fallbackName} is empty`);

  if (/^data:[^;]+;base64,/i.test(raw) || /^https?:\/\//i.test(raw)) {
    return { type: "image_url", image_url: { url: raw } };
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
  const images = extractImagePayloads(payload);
  if (images.length === 0) {
    return {
      error: "Image API response did not contain an image",
      responseShape: summarizeImageResponseShape(payload),
      rawResponse: payload
    };
  }

  const format = normalizeOutputFormat(meta.outputFormat);
  const normalizedImages = images.map(image => {
    const item = {};
    if (image.b64) {
      item.dataUrl = `data:image/${format};base64,${stripDataUrlPrefix(image.b64)}`;
      item.outputFormat = format;
    } else if (isBase64DataUrl(image.url)) {
      item.dataUrl = image.url;
      item.outputFormat = extractDataUrlImageFormat(image.url) || format;
    } else if (image.url) {
      item.imageUrl = image.url;
    }
    if (image.revisedPrompt) item.revisedPrompt = image.revisedPrompt;
    return item;
  }).filter(item => item.dataUrl || item.imageUrl);

  if (normalizedImages.length === 0) {
    return {
      error: "Image API response did not contain an image",
      responseShape: summarizeImageResponseShape(payload),
      rawResponse: payload
    };
  }

  const result = {
    success: true,
    endpoint: meta.endpoint,
    model: meta.model,
    prompt: meta.prompt,
    imageCount: normalizedImages.length,
    images: normalizedImages
  };
  if (meta.imageModelId) result.imageModelId = meta.imageModelId;
  if (meta.imageModelName) result.imageModelName = meta.imageModelName;
  if (meta.inputImageCount) result.inputImageCount = meta.inputImageCount;
  if (meta.hasMask) result.maskApplied = true;
  const revisedPrompt = findFirstString(...normalizedImages.map(image => image.revisedPrompt));
  if (revisedPrompt) result.revisedPrompt = revisedPrompt;

  const firstImage = normalizedImages[0];
  if (firstImage.dataUrl) {
    result.dataUrl = firstImage.dataUrl;
    result.outputFormat = firstImage.outputFormat;
  } else if (firstImage.imageUrl) {
    result.imageUrl = firstImage.imageUrl;
  }
  return result;
}

function extractImagePayloads(payload) {
  const candidates = [];
  if (Array.isArray(payload?.data)) candidates.push(...payload.data);
  if (Array.isArray(payload?.images)) candidates.push(...payload.images);
  if (Array.isArray(payload?.choices)) {
    for (const choice of payload.choices) {
      const message = choice?.message || choice?.delta || {};
      if (Array.isArray(message.images)) candidates.push(...message.images);
      if (Array.isArray(message.content)) candidates.push(...message.content);
      if (message.image) candidates.push(message.image);
      if (message.image_url) candidates.push(message.image_url);
      if (typeof message.content === "string") {
        candidates.push(...extractDataUrlCandidatesFromText(message.content));
      }
    }
  }
  if (payload?.image) candidates.push(payload.image);
  if (payload?.b64_json || payload?.url) candidates.push(payload);

  const images = [];
  for (const candidate of candidates) {
    const b64 = findFirstString(
      candidate?.b64_json,
      candidate?.base64,
      candidate?.image_base64,
      candidate?.data,
      candidate?.source?.data,
      candidate?.image_url?.base64
    );
    const url = findFirstString(
      candidate?.url,
      candidate?.image_url,
      candidate?.image_url?.url
    );
    if (b64 || url) {
      images.push({
        b64,
        url,
        revisedPrompt: findFirstString(candidate?.revised_prompt, candidate?.revisedPrompt)
      });
    }
  }

  return images;
}

function resolveChatCompletionsRequestUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    if (!normalizedPath || normalizedPath === "/") {
      parsed.pathname = CHAT_COMPLETIONS_PATH;
    } else if (/\/chat\/completions$/i.test(normalizedPath)) {
      parsed.pathname = normalizedPath;
    } else if (/\/v1$/i.test(normalizedPath)) {
      parsed.pathname = `${normalizedPath}/chat/completions`;
    } else {
      parsed.pathname = `${normalizedPath}/v1/chat/completions`;
    }
    return parsed.toString();
  } catch {
    const withoutSlash = raw.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(withoutSlash)) return withoutSlash;
    if (/\/v1$/i.test(withoutSlash)) return `${withoutSlash}/chat/completions`;
    return `${withoutSlash}${CHAT_COMPLETIONS_PATH}`;
  }
}

async function imageSourceToFile(source, fallbackName) {
  const raw = String(source || "").trim();
  if (!raw) throw new Error(`${fallbackName} is empty`);

  if (/^data:[^;]+;base64,/i.test(raw)) {
    const parsed = parseBase64DataUrl(raw);
    if (!parsed) throw new Error(`Invalid data URL for ${fallbackName}`);
    const { mediaType, base64Data } = parsed;
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

function parseBase64DataUrl(dataUrl) {
  const raw = typeof dataUrl === "string" ? dataUrl : "";
  if (!raw.startsWith("data:")) return null;
  const marker = ";base64,";
  const markerIndex = raw.toLowerCase().indexOf(marker);
  if (markerIndex <= "data:".length) return null;
  const mediaType = raw.slice("data:".length, markerIndex);
  const base64Data = raw.slice(markerIndex + marker.length);
  if (!mediaType || !base64Data) return null;
  return { mediaType, base64Data };
}

function stripDataUrlPrefix(value) {
  const raw = String(value || "").trim();
  const marker = ";base64,";
  const markerIndex = raw.toLowerCase().indexOf(marker);
  return raw.startsWith("data:") && markerIndex > "data:".length
    ? raw.slice(markerIndex + marker.length)
    : raw;
}

function isBase64DataUrl(value) {
  return /^data:image\/[^;]+;base64,/i.test(String(value || "").trim());
}

function extractDataUrlImageFormat(value) {
  const match = String(value || "").trim().match(/^data:image\/([^;]+);base64,/i);
  if (!match) return "";
  const format = match[1].toLowerCase();
  return format === "jpg" ? "jpeg" : format;
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

const MARKDOWN_IMAGE_DATA_URL_PATTERN = /!\[[^\]]*\]\((data:image\/[^;]+;base64,[^)]+)\)/gi;
const BARE_DATA_URL_PATTERN = /(data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+)/g;

function extractDataUrlCandidatesFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const results = [];
  let match;
  // First pass: extract markdown-wrapped data URLs ![...](data:image/...;base64,...)
  while ((match = MARKDOWN_IMAGE_DATA_URL_PATTERN.exec(raw)) !== null) {
    results.push({ url: match[1] });
  }
  // Second pass: extract bare data URLs if no markdown-wrapped ones were found
  if (results.length === 0) {
    while ((match = BARE_DATA_URL_PATTERN.exec(raw)) !== null) {
      results.push({ url: match[1].replace(/\s+/g, "") });
    }
  }
  return results;
}
