import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: () => null,
  Card: () => null,
  Dialog: () => null
}));

import { buildImageEditRewindHint, buildRewindRestoredAttachments } from "./AgentPanel";
import { hydrateSessionMessages } from "../../api/agent/sessions";

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

  it("restores regular queued image refs back into pending attachments", () => {
    const target = {
      role: "user",
      content: "看这张图",
      imageRefs: [
        { ref: "img_4", dataUrl: "data:image/png;base64,b3JpZw==" }
      ]
    };

    const attachments = buildRewindRestoredAttachments(target);

    expect(attachments.map(item => ({ type: item.type, dataUrl: item.dataUrl, fileName: item.fileName }))).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,b3JpZw==", fileName: "image" }
    ]);
  });

  it("does not duplicate regular images restored from content and image refs", () => {
    const target = {
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image", ref: "img_4", source: { type: "base64", media_type: "image/png", data: "b3JpZw==", ref: "img_4" } }
      ],
      imageRefs: [
        { ref: "img_4", dataUrl: "data:image/png;base64,b3JpZw==" }
      ]
    };

    const attachments = buildRewindRestoredAttachments(target);

    expect(attachments.map(item => ({ type: item.type, dataUrl: item.dataUrl, fileName: item.fileName }))).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,b3JpZw==", fileName: "image" }
    ]);
  });

  it("restores regular queued images from compacted storage refs", () => {
    const [hydrated] = hydrateSessionMessages([{
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image", ref: "img_4", source: { type: "session_image", ref: "img_4", media_type: "image/png" } }
      ],
      imageRefs: [
        { ref: "img_4", dataUrl: "session-image:img_4" }
      ]
    }], {
      img_4: "data:image/png;base64,b3JpZw=="
    });

    const attachments = buildRewindRestoredAttachments(hydrated);

    expect(attachments.map(item => ({ type: item.type, dataUrl: item.dataUrl, fileName: item.fileName }))).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,b3JpZw==", fileName: "image" }
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
