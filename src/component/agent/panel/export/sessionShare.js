export const SESSION_SHARE_ENDPOINT = "https://share-session.xiaogenban1993.com/share";
const ENCRYPTED_SHARE_PREFIX = "#!encrypted:v1\n";
const MAX_SHARE_MIB = 100;
const MAX_SHARE_BYTES = MAX_SHARE_MIB * 1024 * 1024;

function getWebCrypto() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("当前环境不支持分享加密");
  }
  return cryptoApi;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function utf8Size(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

export async function encryptMarkdownForShare(markdown, password) {
  if (typeof markdown !== "string") {
    throw new TypeError("markdown 必须是字符串");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password 必须是非空字符串");
  }

  const cryptoApi = getWebCrypto();
  const encoder = new TextEncoder();
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const iterations = 310000;
  const passwordKey = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const aesKey = await cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = new Uint8Array(
    await cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      encoder.encode(markdown)
    )
  );

  return ENCRYPTED_SHARE_PREFIX + JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2",
    hash: "SHA-256",
    iterations,
    salt: base64Url(salt),
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext)
  });
}

export async function shareMarkdown({ endpoint = SESSION_SHARE_ENDPOINT, markdown, password = "" }) {
  if (typeof markdown !== "string") {
    throw new TypeError("markdown 必须是字符串");
  }

  const normalizedPassword = typeof password === "string" ? password.trim() : "";
  const payload = normalizedPassword
    ? await encryptMarkdownForShare(markdown, normalizedPassword)
    : markdown;

  if (utf8Size(payload) >= MAX_SHARE_BYTES) {
    throw new Error(`分享内容过大，超过 ${MAX_SHARE_MIB} MiB 限制；请删减内容或改用导出为文件`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status} ${errorText}`.trim());
  }

  return response.json();
}

export async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      if (!isClipboardFocusError(error)) {
        throw error;
      }
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.top = "0";
  textarea.style.left = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (document.execCommand("copy")) return true;
  } finally {
    textarea.remove();
  }

  return false;
}

function isClipboardFocusError(error) {
  return error?.name === "NotAllowedError"
    || /document is not focused/i.test(String(error?.message || ""));
}
