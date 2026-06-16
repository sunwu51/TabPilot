import { describe, expect, it } from "vitest";
import { bytesToBase64, decodeCompressedJson, encodeCompressedJson } from "./codec";

describe("sync codec", () => {
  it("round-trips compressed unicode JSON through base64", () => {
    const payload = {
      title: "你好",
      nested: { text: "重复内容".repeat(20) }
    };
    const encoded = encodeCompressedJson(payload);

    expect(typeof encoded).toBe("string");
    expect(() => btoa(JSON.stringify(payload))).toThrow();
    expect(decodeCompressedJson(encoded)).toEqual(payload);
  });

  it("decodes legacy plain JSON content from GitHub", () => {
    const payload = { stashes: { "中文": { info: "内容", updatedAt: 1 } } };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));

    expect(decodeCompressedJson(bytesToBase64(bytes))).toEqual(payload);
  });
});