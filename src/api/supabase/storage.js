import { loadSupabaseConfig, hasUsableSupabaseConfig, normalizeStoragePath } from "./config";

export const SUPABASE_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function uploadSupabaseObject(path, body, options = {}) {
  const config = options.config || await loadSupabaseConfig();
  if (!hasUsableSupabaseConfig(config)) {
    throw new Error("请先在设置中配置 Supabase URL、Key 和 Bucket");
  }
  const normalizedPath = normalizeStoragePath(path);
  const response = await fetch(buildObjectUrl(config, normalizedPath), {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": options.contentType || "application/octet-stream",
      "x-upsert": options.upsert === false ? "false" : "true"
    },
    body
  });
  if (!response.ok) throw new Error(await readSupabaseError(response));
  return {
    path: normalizedPath
  };
}

export async function createSupabaseSignedUrl(path, options = {}) {
  const config = options.config || await loadSupabaseConfig();
  if (!hasUsableSupabaseConfig(config)) throw new Error("Supabase 配置不完整");
  const normalizedPath = normalizeStoragePath(path);
  const response = await fetch(`${config.url}/storage/v1/object/sign/${encodePath(config.bucket)}/${encodePath(normalizedPath)}`, {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: SUPABASE_SIGNED_URL_TTL_SECONDS })
  });
  if (!response.ok) throw new Error(await readSupabaseError(response));
  const payload = await response.json();
  const signedUrl = String(payload?.signedURL || payload?.signedUrl || "");
  if (!signedUrl) throw new Error("Supabase 未返回 signed URL");
  return /^https?:\/\//i.test(signedUrl) ? signedUrl : `${config.url}/storage/v1${signedUrl.startsWith("/") ? "" : "/"}${signedUrl}`;
}

export async function downloadSupabaseObject(path, options = {}) {
  const config = options.config || await loadSupabaseConfig();
  if (!hasUsableSupabaseConfig(config)) throw new Error("Supabase 配置不完整");
  const response = await fetch(buildObjectUrl(config, normalizeStoragePath(path)), {
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }
  });
  if (!response.ok) throw createSupabaseError(response, await readSupabaseError(response));
  return response;
}

function buildObjectUrl(config, path) {
  return `${config.url}/storage/v1/object/${encodePath(config.bucket)}/${encodePath(path)}`;
}

function encodePath(value) {
  return String(value || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function readSupabaseError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed.message || parsed.error || `Supabase 请求失败 (${response.status})`;
  } catch {
    return text || `Supabase 请求失败 (${response.status})`;
  }
}

function createSupabaseError(response, message) {
  const error = new Error(message);
  error.status = response.status;
  return error;
}

export function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error("图片不是有效的 base64 data URL");
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

export function mediaTypeExtension(mediaType) {
  const normalized = String(mediaType || "").toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  return "png";
}
