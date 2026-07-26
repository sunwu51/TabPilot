import { describe, expect, it } from "vitest";
import { hasUsableSupabaseConfig, normalizeSupabaseConfig } from "./config";

describe("Supabase config", () => {
  it("uses TABPILOT as the default root directory", () => {
    expect(normalizeSupabaseConfig({}).basePath).toBe("TABPILOT");
  });

  it("normalizes object paths and validates required fields", () => {
    const config = normalizeSupabaseConfig({
      url: "https://demo.supabase.co/",
      key: " key ",
      bucket: "chat images",
      basePath: "/my chat files/"
    });
    expect(config).toEqual({
      url: "https://demo.supabase.co",
      key: "key",
      bucket: "chat-images",
      basePath: "my-chat-files"
    });
    expect(hasUsableSupabaseConfig(config)).toBe(true);
  });
});
