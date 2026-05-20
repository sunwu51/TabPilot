import { describe, expect, it, vi } from "vitest";
import {
  copyTextToClipboard,
  encryptMarkdownForShare,
  shareMarkdown
} from "./sessionShare";

describe("sessionShare", () => {
  it("encrypts markdown into the viewer-compatible envelope", async () => {
    const encrypted = await encryptMarkdownForShare("# hello", "secret");

    expect(encrypted.startsWith("#!encrypted:v1\n")).toBe(true);

    const envelope = JSON.parse(encrypted.slice("#!encrypted:v1\n".length));
    expect(envelope).toMatchObject({
      v: 1,
      alg: "AES-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: 310000
    });
    expect(envelope.salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(envelope.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(envelope.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uploads plaintext markdown as a JSON string", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ viewerUrl: "https://example.com/shared/1" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await shareMarkdown({
      endpoint: "https://example.com/share",
      markdown: "# plain"
    });

    expect(result.viewerUrl).toBe("https://example.com/shared/1");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/share", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("# plain")
    }));
  });

  it("uploads encrypted markdown when a password is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ viewerUrl: "https://example.com/shared/2" })
    });
    vi.stubGlobal("fetch", fetchMock);

    await shareMarkdown({
      endpoint: "https://example.com/share",
      markdown: "# secret",
      password: "  password  "
    });

    const request = fetchMock.mock.calls[0][1];
    const uploaded = JSON.parse(request.body);
    expect(uploaded.startsWith("#!encrypted:v1\n")).toBe(true);
    expect(uploaded).not.toContain("# secret");
  });

  it("copies text through navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });

    await expect(copyTextToClipboard("https://example.com")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.com");
  });
});
