import { describe, expect, it } from "vitest";
import { exportCurl, importCurl } from "./curl";

describe("postdog curl import/export", () => {
  it("imports common curl flags into a request", () => {
    const request = importCurl("curl -X POST 'https://api.example.com/items' -H 'Authorization: Bearer t' -H 'Content-Type: application/json' --data-raw '{\"name\":\"a\"}'", {
      name: "create item",
      folderId: "folder-1"
    });

    expect(request).toMatchObject({
      name: "create item",
      folderId: "folder-1",
      method: "POST",
      url: "https://api.example.com/items",
      body: { type: "json", text: "{\"name\":\"a\"}" }
    });
    expect(request.headers).toEqual([
      { key: "Authorization", value: "Bearer t", enabled: true, secret: true },
      { key: "Content-Type", value: "application/json", enabled: true, secret: false }
    ]);
  });

  it("exports a request as curl", () => {
    expect(exportCurl({
      method: "PATCH",
      url: "https://api.example.com/items/{{objId}}",
      headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
      body: { type: "json", text: "{\"name\":\"b\"}" }
    })).toContain("--data-raw");
  });
});

describe("postdog curl export bodies", () => {
  it("exports form and multipart fields", () => {
    const form = exportCurl({
      method: "POST",
      url: "https://x.test",
      headers: [],
      body: { type: "form", fields: [{ key: "a", value: "1 2", enabled: true }, { key: "b", value: "x", enabled: false }] }
    });
    expect(form).toContain("--data-raw a=1+2");

    const multipart = exportCurl({
      method: "POST",
      url: "https://x.test",
      headers: [],
      body: { type: "multipart", fields: [
        { key: "name", value: "n", enabled: true, kind: "text" },
        { key: "file", kind: "file", fileName: "a.png", mimeType: "image/png", enabled: true }
      ] }
    });
    expect(multipart).toContain("-F name=n");
    expect(multipart).toContain("-F 'file=@a.png;type=image/png'");
  });
});
