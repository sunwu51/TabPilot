import { describe, expect, it } from "vitest";

import {
  collectReservedImageRefsFromMessages,
  extractPreferredImageRefFromToolMessage,
  mergeKnownImageRefsIntoMessages,
  replaceBase64ImageDataUrlsWithRefs
} from "./imageRefs";

describe("AgentPanel image ref helpers", () => {
  it("replaces nested base64 images with stable refs before code receives them", () => {
    const register = dataUrl => dataUrl.includes("b25l") ? "img_1" : "img_2";
    const firstImage = "data:image/png;base64,b25l";
    const secondImage = "data:image/jpeg;base64,dHdv";

    const transformed = replaceBase64ImageDataUrlsWithRefs({
      dataUrl: firstImage,
      images: [{ dataUrl: firstImage }, { nested: { source: secondImage } }],
      ordinaryData: "data:application/json;base64,e30="
    }, register);

    expect(transformed.value).toEqual({
      dataUrl: "|deRef:img_1|",
      images: [{ dataUrl: "|deRef:img_1|" }, { nested: { source: "|deRef:img_2|" } }],
      ordinaryData: "data:application/json;base64,e30="
    });
    expect(transformed.images).toEqual([
      { ref: "img_1", dataUrl: firstImage, mediaType: "image/png" },
      { ref: "img_2", dataUrl: secondImage, mediaType: "image/jpeg" }
    ]);
  });

  it("collects refs from edit prompts and tool result instructions", () => {
    const refs = collectReservedImageRefsFromMessages([
      {
        role: "user",
        content: "原图 ref: img_1\nmask ref: img_2\n![image](|deRef:img_6|)"
      },
      {
        role: "tool",
        content: JSON.stringify({
          imageRefInstruction:
            "Tool returned an image ref: img_3. To preview it, write ![image](|deRef:img_3|)."
        })
      }
    ]);

    expect(Array.from(refs).sort()).toEqual(["img_1", "img_2", "img_3", "img_6"]);
  });

  it("recovers the stable output ref from a tool result instruction", () => {
    expect(extractPreferredImageRefFromToolMessage({
      role: "tool",
      displayImageUrl: "data:image/png;base64,b3V0",
      content: JSON.stringify({
        imageRefInstruction:
          "Tool returned an image ref: img_6. To preview it, write Markdown exactly as ![image](|deRef:img_6|)."
      })
    })).toBe("img_6");
  });

  it("recovers the stable output ref from structured tool result refs", () => {
    expect(extractPreferredImageRefFromToolMessage({
      role: "tool",
      displayImageUrl: "data:image/png;base64,b3V0",
      content: JSON.stringify({
        imageRefs: ["img_6"],
        imageRefInstruction: "wording can change"
      })
    })).toBe("img_6");
  });

  it("persists known refs referenced only by text before saving messages", () => {
    const cache = {
      refs: new Map([
        ["img_2", "data:image/png;base64,bWFzaw=="],
        ["img_6", "data:image/png;base64,b3V0"]
      ]),
      byDataUrl: new Map([
        ["data:image/png;base64,b3V0", "img_6"]
      ])
    };
    const messages = [
      {
        role: "user",
        content: "mask ref: img_2\n调用工具时传入 `|deRef:img_2|`。"
      },
      {
        role: "tool",
        displayImageUrl: "data:image/png;base64,b3V0",
        content: JSON.stringify({
          imageRefInstruction: "Tool returned an image ref: img_6."
        })
      }
    ];

    const next = mergeKnownImageRefsIntoMessages(messages, cache);

    expect(next[0].imageRefs).toEqual([
      { ref: "img_2", dataUrl: "data:image/png;base64,bWFzaw==" }
    ]);
    expect(next[1].imageRefs).toEqual([
      { ref: "img_6", dataUrl: "data:image/png;base64,b3V0" }
    ]);
  });
});
