import { describe, expect, it } from "vitest";
import { deflateStringToQueryParam, inflateStringFromQueryParam } from "./playgroundCodec";

describe("playground codec", () => {
  it("encodes payloads with zlib header compatible with HtmlPlayground pako.inflate", () => {
    const encoded = deflateStringToQueryParam("<h1>你好</h1>");
    const compressed = Uint8Array.from(atob(decodeURIComponent(encoded)), ch => ch.charCodeAt(0));

    expect(Array.from(compressed.slice(0, 2))).toEqual([0x78, 0x01]);
    expect(inflateStringFromQueryParam(encoded)).toBe("<h1>你好</h1>");
  });
});
