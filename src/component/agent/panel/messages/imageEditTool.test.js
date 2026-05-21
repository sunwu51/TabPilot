import { describe, expect, it } from "vitest";

import { buildImageEditPreviewImages, buildImageEditUserPrompt } from "./imageEditTool";

describe("imageEditTool", () => {
  it("uses raw http image URLs when refs are unavailable", () => {
    const prompt = buildImageEditUserPrompt({
      toolCallName: "image_edit",
      imageSource: "https://example.com/original.png",
      additionalImageSources: ["https://example.com/reference.png"],
      suggestion: "把天空变亮"
    });

    expect(prompt).toContain("原图 URL: https://example.com/original.png");
    expect(prompt).toContain("`https://example.com/original.png`, `https://example.com/reference.png`");
    expect(prompt).toContain("如果工具没有 images 参数，请传入 image 参数: `https://example.com/original.png`");
  });

  it("keeps preview images even when only some inputs have refs", () => {
    expect(buildImageEditPreviewImages({
      imageSource: "https://example.com/original.png",
      referenceRefs: ["img_2"],
      referenceSources: ["data:image/png;base64,cmVm"]
    })).toEqual([
      { ref: "", dataUrl: "https://example.com/original.png", role: "edit_image" },
      { ref: "img_2", dataUrl: "data:image/png;base64,cmVm", role: "edit_reference" }
    ]);
  });
});
