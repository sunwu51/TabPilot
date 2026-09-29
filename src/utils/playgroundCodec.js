import pako from "pako";

// Matches HtmlPlayground's share format: deflate + base64url (no "+", "/", "=" so it needs no URL escaping).
export function deflateStringToQueryParam(input = "") {
  const text = String(input ?? "");
  try {
    return bytesToBinaryBase64(pako.deflate(text))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch (error) {
    console.warn("Failed to compress playground payload, falling back to raw URI encoding:", error);
    return encodeURIComponent(text);
  }
}

// Accepts both base64url (current) and percent-encoded standard base64 (legacy links).
export function inflateStringFromQueryParam(input = "") {
  if (!input) return "";
  try {
    let base64 = decodeURIComponent(input).replace(/-/g, "+").replace(/_/g, "/");
    base64 += "=".repeat((4 - (base64.length % 4)) % 4);
    return pako.inflate(binaryStringToBytes(atob(base64)), { to: "string" });
  } catch (error) {
    try {
      return decodeURIComponent(input);
    } catch {
      return String(input);
    }
  }
}

function bytesToBinaryBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function binaryStringToBytes(binary) {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
