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
