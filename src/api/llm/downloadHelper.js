/* global chrome */

/**
 * Encode a JS string into a base64 data URL via UTF-8.
 */
function _textToDataUrl(text, mimeType = "text/plain;charset=utf-8") {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mimeType};base64,${btoa(bin)}`;
}

/**
 * Trigger a browser download via chrome.downloads.
 *
 * Provide either:
 *   - `url`: an http(s) URL (browser cookies/session are sent), or a base64 data: URL
 *   - `content`: a plain text string written into the file (encoded with `mimeType`)
 *
 * `mimeType` only affects `content` downloads because those are re-encoded into
 * data: URLs locally. For URL downloads, the remote response or data: URL
 * itself determines the MIME type.
 *
 * Returns an object describing the result; never throws.
 */
export async function triggerBrowserDownload({ fileName, url, content, mimeType = "text/plain;charset=utf-8" } = {}) {
  if (!fileName || typeof fileName !== "string") {
    return { error: "fileName is required and must be a string" };
  }
  if (!chrome?.downloads?.download) {
    return { error: "chrome.downloads API is unavailable in this context" };
  }

  const hasUrl = typeof url === "string" && url.length > 0;
  const hasContent = content !== undefined && content !== null;
  if (hasUrl && hasContent) {
    return { error: "Provide either `url` or `content`, not both" };
  }
  if (!hasUrl && !hasContent) {
    return { error: "Either `url` or `content` is required" };
  }

  let downloadUrl;
  let source;
  let size = null;

  if (hasUrl) {
    if (!/^(https?:|data:)/i.test(url)) {
      return { error: "url must start with http://, https://, or data:" };
    }
    downloadUrl = url;
    source = url.startsWith("data:") ? "data-url" : "http-url";
  } else {
    const text = String(content);
    size = new TextEncoder().encode(text).length;
    downloadUrl = _textToDataUrl(text, mimeType);
    source = "content";
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename: fileName,
      saveAs: false,
      conflictAction: "uniquify"
    });
    return {
      success: true,
      fileName,
      source,
      ...(size != null ? { size } : {}),
      downloadId
    };
  } catch (e) {
    return {
      error: e?.message || String(e),
      hint: "chrome.downloads.download failed. For URL downloads, verify the URL is reachable; for content downloads, the file may have been blocked by browser policy."
    };
  }
}
