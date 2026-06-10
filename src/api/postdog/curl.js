import { newPostdogId, normalizeRequest } from "./index";

function shellSplit(input) {
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of String(input || "")) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

export function importCurl(curlText, options = {}) {
  const tokens = shellSplit(String(curlText || "").replace(/\\\r?\n/g, " "));
  if (tokens[0] !== "curl") throw new Error("Only curl commands are supported");
  const request = {
    id: newPostdogId("pdr"),
    name: options.name || "Imported curl",
    folderId: options.folderId || null,
    method: "",
    url: "",
    headers: [],
    query: [],
    body: { type: "none", text: "" },
    preScript: "",
    postScript: ""
  };

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = () => tokens[++i] || "";
    if (token === "-X" || token === "--request") {
      request.method = next().toUpperCase();
    } else if (token.startsWith("-X") && token.length > 2) {
      request.method = token.slice(2).toUpperCase();
    } else if (token === "-H" || token === "--header") {
      addHeader(request, next());
    } else if (token.startsWith("-H") && token.length > 2) {
      addHeader(request, token.slice(2));
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"].includes(token)) {
      request.body = { type: guessBodyType(next()), text: request.body.text ? `${request.body.text}&${tokens[i]}` : tokens[i] };
      if (!request.method) request.method = "POST";
    } else if (token.startsWith("--data=")) {
      const value = token.slice("--data=".length);
      request.body = { type: guessBodyType(value), text: value };
      if (!request.method) request.method = "POST";
    } else if (token === "--url") {
      request.url = next();
    } else if (token === "-u" || token === "--user") {
      const value = next();
      request.headers.push({ key: "Authorization", value: `Basic ${btoa(value)}`, enabled: true, secret: true });
    } else if (!token.startsWith("-") && !request.url) {
      request.url = token;
    }
  }

  request.method = request.method || "GET";
  return normalizeRequest(request);
}

function addHeader(request, raw) {
  const index = String(raw || "").indexOf(":");
  if (index <= 0) return;
  request.headers.push({
    key: raw.slice(0, index).trim(),
    value: raw.slice(index + 1).trim(),
    enabled: true,
    secret: /^authorization$/i.test(raw.slice(0, index).trim())
  });
}

function guessBodyType(value) {
  const text = String(value || "").trim();
  if (!text) return "none";
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) return "json";
  return "text";
}

export function exportCurl(request) {
  if (!request) throw new Error("request is required");
  const lines = ["curl"];
  lines.push(`  -X ${quoteShell(request.method || "GET")}`);
  if (request.url) lines.push(`  ${quoteShell(request.url)}`);
  for (const header of request.headers || []) {
    if (header.enabled === false || !header.key) continue;
    lines.push(`  -H ${quoteShell(`${header.key}: ${header.value ?? ""}`)}`);
  }
  if (request.body?.type && request.body.type !== "none" && request.body.text) {
    lines.push(`  --data-raw ${quoteShell(request.body.text)}`);
  }
  return lines.join(" \\\n");
}

function quoteShell(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=?&%{}[\],+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export function exportPostdogJson({ folders = [], requests = [], environments = [] } = {}) {
  return JSON.stringify({
    type: "tabmanager.postdog",
    version: 1,
    exportedAt: new Date().toISOString(),
    folders,
    requests,
    environments
  }, null, 2);
}

export function parsePostdogJson(text) {
  const parsed = JSON.parse(text);
  if (parsed?.type !== "tabmanager.postdog" || parsed.version !== 1) {
    throw new Error("Unsupported Postdog JSON");
  }
  return {
    folders: Array.isArray(parsed.folders) ? parsed.folders : [],
    requests: Array.isArray(parsed.requests) ? parsed.requests : [],
    environments: Array.isArray(parsed.environments) ? parsed.environments : []
  };
}
