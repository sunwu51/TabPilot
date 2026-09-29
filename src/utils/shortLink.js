export const SHORT_LINK_ENDPOINT = "https://tiny.wuyao.org/create";
// Keep this short: copying to the clipboard after the request still needs the click's user activation.
const SHORT_LINK_TIMEOUT_MS = 3000;

/**
 * Shorten a URL with the tiny.wuyao.org service (a TinyURL proxy). Resolves to the short URL,
 * or to `null` when the service is unreachable, out of quota, or rejects the URL, so callers
 * can fall back to the long one.
 */
export async function createShortLink(url, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHORT_LINK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(SHORT_LINK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    const shortUrl = data?.data?.tiny_url;
    if (!response.ok || typeof shortUrl !== "string") {
      console.warn("Short link service rejected the request:", response.status, data?.errors);
      return null;
    }
    return shortUrl;
  } catch (error) {
    console.warn("Short link service is unavailable, using the full link instead:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
