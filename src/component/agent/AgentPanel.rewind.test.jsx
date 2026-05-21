import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: () => null,
  Card: () => null,
  Dialog: () => null
}));

import { buildImageEditRewindHint, buildRewindRestoredAttachments } from "./AgentPanel";

describe("AgentPanel rewind attachments", () => {
  it("restores image edit refs back into pending attachments", () => {
    const target = {
      role: "user",
      content: "请编辑图片",
      imageRefs: [
        { ref: "img_4", dataUrl: "data:image/png;base64,b3JpZw==", role: "edit_image" },
        { ref: "img_7", dataUrl: "data:image/png;base64,cmVm", role: "edit_reference" },
        { ref: "img_8", dataUrl: "data:image/png;base64,bWFzaw==", role: "edit_mask" }
      ]
    };

    const attachments = buildRewindRestoredAttachments(target);

    expect(attachments.map(item => ({ type: item.type, dataUrl: item.dataUrl, fileName: item.fileName }))).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,b3JpZw==", fileName: "edit-image" },
      { type: "image", dataUrl: "data:image/png;base64,cmVm", fileName: "edit-reference" },
      { type: "image", dataUrl: "data:image/png;base64,bWFzaw==", fileName: "edit-mask" }
    ]);
  });

  it("stores image edit metadata on the message for rewind hinting", () => {
    const msg = {
      role: "user",
      displayContent: "编辑图片：加个帽子",
      imageEditMeta: {
        kind: "image_edit",
        hasMask: true,
        referenceCount: 1
      }
    };

    expect(msg.imageEditMeta).toEqual({
      kind: "image_edit",
      hasMask: true,
      referenceCount: 1
    });
  });

  it("restores http image edit previews from imageEditMeta without refs", () => {
    const target = {
      role: "user",
      content: "请编辑图片",
      imageEditMeta: {
        kind: "image_edit",
        images: [
          { dataUrl: "https://example.com/original.png", role: "edit_image" },
          { dataUrl: "https://example.com/reference.png", role: "edit_reference" }
        ]
      }
    };

    const attachments = buildRewindRestoredAttachments(target);

    expect(attachments.map(item => ({ type: item.type, dataUrl: item.dataUrl, fileName: item.fileName }))).toEqual([
      { type: "image", dataUrl: "https://example.com/original.png", fileName: "edit-image" },
      { type: "image", dataUrl: "https://example.com/reference.png", fileName: "edit-reference" }
    ]);
  });

  it("uses the original http url in rewind hint instead of claiming attachment 1 is the original", () => {
    const hint = buildImageEditRewindHint({
      kind: "image_edit",
      images: [
        { dataUrl: "https://example.com/original.png", role: "edit_image" },
        { dataUrl: "data:image/png;base64,cmVm", role: "edit_reference" }
      ]
    });

    expect(hint).toContain("https://example.com/original.png 是原图");
    expect(hint).toContain("第1张图是参考图1");
    expect(hint).not.toContain("第1张图是原图");
  });
});
