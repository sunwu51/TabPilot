import pako from "pako";

export function encodeCompressedJson(value) {
  const json = JSON.stringify(value);
  const bytes = pako.deflate(json);
  return bytesToBase64(bytes);
}

export function decodeCompressedJson(base64) {
  return decodePossiblyCompressedJson(base64);
}

export function decodePossiblyCompressedJson(base64) {
  const bytes = base64ToBytes(base64);
  try {
    const json = pako.inflate(bytes, { to: "string" });
    return JSON.parse(json);
  } catch (inflateError) {
    const text = new TextDecoder().decode(bytes).trim();
    if (!text) throw inflateError;
    try {
      return JSON.parse(text);
    } catch {
      try {
        return JSON.parse(new TextDecoder().decode(base64ToBytes(text)).trim());
      } catch {
        throw inflateError;
      }
    }
  }
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 || "").replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}