/* eslint-disable react/prop-types */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, ...props }) => <button type="button" onClick={onPress} {...props}>{children}</button>,
  Dialog: ({ children, trigger }) => <div>{trigger}{children}</div>
}));

import ChatMessage from "./ChatMessage";

describe("ChatMessage image actions", () => {
  it("opens the image in a new tab from the ref button", async () => {
    chrome.tabs.create = vi.fn(() => Promise.resolve({ id: 1 }));

    render(
      <ChatMessage
        msg={{
          role: "user",
          content: [{
            type: "image",
            ref: "img_9",
            source: { type: "base64", media_type: "image/png", data: "dXNlcg==", ref: "img_9" }
          }],
          imageRefs: [{ ref: "img_9", dataUrl: "data:image/png;base64,dXNlcg==" }]
        }}
        imageEditingEnabled
        onImageEditRequest={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "在新标签页查看 img_9" }));

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "data:image/png;base64,dXNlcg==",
      active: true
    });
  });
});
