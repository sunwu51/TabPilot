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

  it("tells the model uploaded edit references are available through deref placeholders", () => {
    const prompt = buildImageEditUserPrompt({
      toolCallName: "image_edit",
      imageRef: "img_1",
      imageSource: "data:image/png;base64,b3JpZw==",
      additionalImageRefs: ["img_ref2"],
      additionalImageSources: ["data:image/png;base64,cmVm"],
      suggestion: "参考第二张图的构图"
    });

    expect(prompt).toContain("`|deRef:img_1|`, `|deRef:img_ref2|`");
    expect(prompt).toContain("这些 ref 对应的图片已经由用户上传并保存在当前会话的 imageRefs 中");
    expect(prompt).toContain("即使你之前没有见过某个 ref，也应当认为图片已存在");
    expect(prompt.split("\n").at(-1)).toContain("工具调用时直接使用对应的 `|deRef:...|` 占位符获取图片数据");
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
