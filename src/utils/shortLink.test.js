import { describe, expect, it, vi } from "vitest";
import { SHORT_LINK_ENDPOINT, createShortLink } from "./shortLink";

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("createShortLink", () => {
  it("posts the url and returns the tiny url", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      code: 0,
      data: { tiny_url: "https://tinyurl.com/2abc3def", url: "https://sunwu51.github.io/HtmlPlayground/#html=x" },
      errors: []
    }));
    const shortUrl = await createShortLink("https://sunwu51.github.io/HtmlPlayground/#html=x", { fetchImpl });

    expect(shortUrl).toBe("https://tinyurl.com/2abc3def");
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe(SHORT_LINK_ENDPOINT);
    expect(endpoint).toBe("https://tiny.wuyao.org/create");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ url: "https://sunwu51.github.io/HtmlPlayground/#html=x" });
  });

  it("returns null when every account is out of quota", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {
      code: 1,
      data: [],
      errors: ["No available API tokens in the pool (monthly quota exhausted or no tokens added)."]
    }));
    expect(await createShortLink("https://sunwu51.github.io/", { fetchImpl })).toBeNull();
  });

  it("returns null when the response has no tiny url", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { code: 0, data: [], errors: [] }));
    expect(await createShortLink("https://sunwu51.github.io/", { fetchImpl })).toBeNull();
  });

  it("returns null when the network request fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await createShortLink("https://sunwu51.github.io/", { fetchImpl })).toBeNull();
  });
});
