import { getLongToolArgumentFields } from "../../../../api/llm/longToolArgs";
import { escapeRegExp } from "../search/globalSearch";
export function buildStreamingToolArgsState(event) {
  const name = event?.name || "";
  const rawArgs = typeof event?.arguments === "string" ? event.arguments : "";
  const fields = getLongToolArgumentFields(name);
  if (!name || fields.length === 0) return null;
  const preview = buildStreamingToolArgumentPreview(name, rawArgs, fields);
  return {
    id: event?.id || event?.responseItemId || `${name}-${event?.index ?? 0}`,
    name,
    preview
  };
}

export function buildStreamingToolArgumentPreview(toolName, rawArgs, fields) {
  const parsed = tryParseJson(rawArgs);
  if (parsed && typeof parsed === "object") {
    const parts = [];
    for (const field of fields) {
      if (typeof parsed[field] === "string" && parsed[field]) {
        parts.push(`${field}=${parsed[field]}`);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  const extracted = [];
  for (const field of fields) {
    const value = extractPartialJsonStringValue(rawArgs, field);
    if (value) extracted.push(`${field}=${value}`);
  }
  if (extracted.length > 0) return extracted.join("\n");
  return rawArgs || `${toolName} 参数生成中`;
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

export function extractPartialJsonStringValue(jsonText, fieldName) {
  const text = String(jsonText || "");
  const fieldPattern = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"`, "g");
  const match = fieldPattern.exec(text);
  if (!match) return "";
  let result = "";
  let escaped = false;
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      result += decodeJsonEscapeChar(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") break;
    result += ch;
  }
  return result;
}

export function decodeJsonEscapeChar(ch) {
  switch (ch) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "b": return "\b";
    case "f": return "\f";
    case "\"": return "\"";
    case "\\": return "\\";
    case "/": return "/";
    default: return ch;
  }
}
