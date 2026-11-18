import { tr } from "../../i18n";

export function getStatusClass(status) {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300) return "ok";
  if (code >= 300 && code < 400) return "redirect";
  if (code >= 400) return "error";
  return "unknown";
}

export function formatDateTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error(tr("读取文件失败", "Failed to read file")));
    reader.readAsDataURL(file);
  });
}


export const DEFAULT_USER_AGENT = "Postdog/1.0 (TabPilot Chrome Extension)";

// Content-Type values Postdog adds itself; anything else is treated as user-defined and left alone.
const AUTO_CONTENT_TYPES = {
  json: "application/json",
  text: "text/plain;charset=UTF-8",
  form: "application/x-www-form-urlencoded"
};
const AUTO_CONTENT_TYPE_VALUES = new Set([
  ...Object.values(AUTO_CONTENT_TYPES),
  "text/plain",
  "multipart/form-data"
].map(value => value.toLowerCase()));

/**
 * Keep the Content-Type header in step with the chosen body type.
 * - json / text / form: add it, or replace it if it is missing or still one of our own values.
 * - none / multipart: remove our own value (multipart gets its boundary from fetch).
 * A Content-Type the user typed themselves is never touched.
 */
export function syncContentTypeHeader(headers, bodyType) {
  const list = Array.isArray(headers) ? headers : [];
  const index = list.findIndex(item => String(item.key || "").trim().toLowerCase() === "content-type");
  const wanted = AUTO_CONTENT_TYPES[bodyType];
  if (index < 0) {
    return wanted ? [...list, { key: "Content-Type", value: wanted, enabled: true }] : list;
  }
  const current = String(list[index].value || "").trim().toLowerCase();
  const isOurs = !current || AUTO_CONTENT_TYPE_VALUES.has(current);
  if (!isOurs) return list;
  if (!wanted) return list.filter((_, i) => i !== index);
  return list.map((item, i) => i === index ? { ...item, value: wanted, enabled: true } : item);
}

export const HEADER_NAME_SUGGESTIONS = [
  "Accept", "Accept-Charset", "Accept-Encoding", "Accept-Language", "Access-Control-Request-Headers",
  "Access-Control-Request-Method", "Authorization", "Cache-Control", "Connection", "Content-Disposition",
  "Content-Encoding", "Content-Length", "Content-Type", "Cookie", "DNT", "Expect", "Forwarded", "From",
  "Host", "If-Match", "If-Modified-Since", "If-None-Match", "If-Range", "If-Unmodified-Since", "Origin",
  "Pragma", "Proxy-Authorization", "Range", "Referer", "TE", "Upgrade-Insecure-Requests", "User-Agent",
  "X-API-Key", "X-Auth-Token", "X-CSRF-Token", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
  "X-Requested-With", "X-Request-Id", "X-Real-IP", "X-HTTP-Method-Override", "X-Api-Version"
];

export const HEADER_VALUE_SUGGESTIONS = {
  "content-type": ["application/json", "application/x-www-form-urlencoded", "text/plain", "text/html", "application/xml", "application/octet-stream", "multipart/form-data"],
  accept: ["application/json", "*/*", "text/html", "text/plain", "application/xml", "text/event-stream"],
  "accept-encoding": ["gzip, deflate, br"],
  "accept-language": ["zh-CN,zh;q=0.9,en;q=0.8", "en-US,en;q=0.9"],
  "cache-control": ["no-cache", "no-store", "max-age=0"],
  authorization: ["Bearer ", "Basic "],
  connection: ["keep-alive", "close"]
};
