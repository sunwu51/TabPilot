import { describe, expect, it } from "vitest";
import {
  normalizeImageModelProfiles,
  resolveActiveImageConfig,
  syncActiveModelFields
} from "./modelProfiles";
import { isImageApiConfigured } from "../tools/builtins/imageApi";

describe("modelProfiles", () => {
  it("keeps explicitly cleared image model profiles empty", () => {
    const config = {
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "https://api.example.com/v1",
      imageApiKey: "old-token",
      imageModel: "gpt-image-2"
    };

    expect(normalizeImageModelProfiles(config)).toMatchObject({
      profiles: [],
      activeId: "",
      activeProfile: null
    });
    expect(resolveActiveImageConfig(config)).toMatchObject({
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "",
      imageApiKey: "",
      imageModel: "",
      selectedImageProfile: null
    });
    expect(syncActiveModelFields(config)).toMatchObject({
      imageModels: [],
      activeImageModelId: "",
      imageBaseUrl: "",
      imageApiKey: "",
      imageModel: ""
    });
    expect(isImageApiConfigured(config)).toBe(false);
  });

  it("does not migrate legacy image fields at runtime", () => {
    const config = {
      imageBaseUrl: "https://api.example.com/v1",
      imageApiKey: "old-token",
      imageModel: "legacy-image-model"
    };

    expect(normalizeImageModelProfiles(config).profiles).toEqual([]);
    expect(isImageApiConfigured(config)).toBe(false);
  });
});
