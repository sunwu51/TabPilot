const INVISIBLE_TEXT_PATTERN = /[\s\u200B-\u200D\u2060\uFEFF]/g;

export function hasVisibleText(value) {
  return typeof value === "string" && value.replace(INVISIBLE_TEXT_PATTERN, "").length > 0;
}
