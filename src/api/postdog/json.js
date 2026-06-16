import stripJsonCommentsLib from "strip-json-comments";

export function normalizeJsonRequestBody(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return raw;
  const stripped = stripJsonComments(raw);
  const parsed = JSON.parse(stripped);
  return JSON.stringify(parsed);
}

export function formatJsonWithComments(text, space = 2) {
  const raw = String(text ?? "");
  if (!raw.trim()) return "";
  return JSON.stringify(JSON.parse(stripJsonComments(raw)), null, space);
}

export function parseJsonWithComments(text) {
  return JSON.parse(stripJsonComments(text));
}

export function stripJsonComments(text) {
  return stripJsonCommentsLib(String(text ?? ""), { whitespace: false, trailingCommas: true });
}
