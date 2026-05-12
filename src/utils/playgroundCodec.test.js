import { describe, expect, it } from "vitest";
import pako from "pako";
import { deflateStringToQueryParam, inflateStringFromQueryParam } from "./playgroundCodec";

describe("playground codec", () => {
  it("encodes payloads exactly like HtmlPlayground pako.deflate flow", () => {
    const encoded = deflateStringToQueryParam("<h1>你好</h1>");
    const compressed = pako.deflate("<h1>你好</h1>");
    let binary = "";
    for (const byte of compressed) binary += String.fromCharCode(byte);
    const expected = encodeURIComponent(btoa(binary));

    expect(encoded).toBe(expected);
    expect(pako.inflate(compressed, { to: "string" })).toBe("<h1>你好</h1>");
    expect(inflateStringFromQueryParam(encoded)).toBe("<h1>你好</h1>");
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
