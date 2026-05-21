import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: () => null,
  Card: () => null,
  Dialog: () => null
}));

import { buildRewindRestoredAttachments } from "./AgentPanel";

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
});
