/* global chrome */

export const SUPABASE_CONFIG_KEY = "supabaseConfig";

export const SUPABASE_DEFAULT_CONFIG = {
  url: "",
  key: "",
  bucket: "",
  basePath: "TABPILOT"
};

export function normalizeSupabaseConfig(value = {}) {
  return {
    url: String(value?.url || "").trim().replace(/\/+$/, ""),
    key: String(value?.key || "").trim(),
    bucket: normalizePathPart(value?.bucket),
    basePath: normalizeStoragePath(value?.basePath || SUPABASE_DEFAULT_CONFIG.basePath)
  };
}

export function getSupabasePath(config, ...parts) {
  return [config?.basePath, ...parts].map(normalizeStoragePath).filter(Boolean).join("/");
}

export function hasUsableSupabaseConfig(value) {
  const config = normalizeSupabaseConfig(value);
  return /^https:\/\//i.test(config.url) && !!config.key && !!config.bucket;
}

export async function loadSupabaseConfig() {
  const result = await chrome.storage.local.get({ [SUPABASE_CONFIG_KEY]: SUPABASE_DEFAULT_CONFIG });
  return normalizeSupabaseConfig(result[SUPABASE_CONFIG_KEY]);
}

export async function saveSupabaseConfig(value) {
  const config = normalizeSupabaseConfig(value);
  await chrome.storage.local.set({ [SUPABASE_CONFIG_KEY]: config });
  return config;
}

export function normalizeStoragePath(value) {
  return String(value || "")
    .split("/")
    .map(normalizePathPart)
    .filter(Boolean)
    .join("/");
}

export function normalizePathPart(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
