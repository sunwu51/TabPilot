import { describe, expect, it } from "vitest";
import pako from "pako";
import { deflateStringToQueryParam, inflateStringFromQueryParam } from "./playgroundCodec";

function toBinaryBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("playground codec", () => {
  it("encodes payloads exactly like HtmlPlayground pako.deflate + base64url flow", () => {
    const encoded = deflateStringToQueryParam("<h1>你好</h1>");
    const compressed = pako.deflate("<h1>你好</h1>");
    const expected = toBinaryBase64(compressed).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(encoded).toBe(expected);
    expect(encoded).not.toMatch(/[+/=%]/);
    expect(pako.inflate(compressed, { to: "string" })).toBe("<h1>你好</h1>");
    expect(inflateStringFromQueryParam(encoded)).toBe("<h1>你好</h1>");
  });

  it("still decodes legacy percent-encoded standard base64 payloads", () => {
    const source = "<p>legacy + / = ?? 中文 &amp;</p>".repeat(20);
    const legacyEncoded = encodeURIComponent(toBinaryBase64(pako.deflate(source)));
    const legacyFromSearchParams = decodeURIComponent(legacyEncoded);

    expect(inflateStringFromQueryParam(legacyEncoded)).toBe(source);
    expect(inflateStringFromQueryParam(legacyFromSearchParams)).toBe(source);
  });

  it("survives a round trip through URLSearchParams in a URL hash", () => {
    const source = Array.from({ length: 200 }, (_, i) => `var v${i} = ${Math.random().toString(36)};`).join("\n");
    const url = new URL("https://sunwu51.github.io/HtmlPlayground/");
    url.hash = `#${new URLSearchParams({ js: deflateStringToQueryParam(source) })}`;
    const js = new URLSearchParams(new URL(url.toString()).hash.slice(1)).get("js");

    expect(inflateStringFromQueryParam(js)).toBe(source);
  });

  it("actually compresses repetitive HTML before base64/url encoding", () => {
    const source = Array.from({ length: 80 }, (_, index) =>
      `<div class="card"><h2>标题 ${index}</h2><p>重复内容重复内容重复内容</p></div>`
    ).join("");
    const encoded = deflateStringToQueryParam(source);

    expect(encoded.length).toBeLessThan(source.length);
    expect(inflateStringFromQueryParam(encoded)).toBe(source);
  });
});
