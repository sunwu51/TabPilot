import pako from "pako";

export function deflateStringToQueryParam(input = "") {
  const text = String(input ?? "");
  try {
    return encodeURIComponent(bytesToBinaryBase64(pako.deflate(text)));
  } catch (error) {
    console.warn("Failed to compress playground payload, falling back to raw URI encoding:", error);
    return encodeURIComponent(text);
  }
}

export function inflateStringFromQueryParam(input = "") {
  if (!input) return "";
  try {
    return pako.inflate(binaryStringToBytes(atob(decodeURIComponent(input))), { to: "string" });
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
