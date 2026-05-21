/* eslint-disable react/prop-types */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, ...props }) => <button type="button" onClick={onPress} {...props}>{children}</button>,
  Dialog: ({ children, trigger }) => <div>{trigger}{children}</div>
}));

import ChatMessage from "./ChatMessage";

describe("ChatMessage image edit refs", () => {
  it("renders edit_image and edit_reference previews from imageRefs when content has no image blocks", () => {
    render(
      <ChatMessage
        msg={{
          role: "user",
          content: [{ type: "text", text: "请编辑这张图，并参考另一张图。" }],
          imageRefs: [
            { ref: "img_1", dataUrl: "data:image/png;base64,b3JpZw==", role: "edit_image" },
            { ref: "img_2", dataUrl: "data:image/png;base64,cmVm", role: "edit_reference" }
          ]
        }}
      />
    );

    expect(screen.getByText("原图")).toBeInTheDocument();
    expect(screen.getByText("参考图 1")).toBeInTheDocument();
    expect(screen.getByAltText("原图")).toHaveAttribute("src", "data:image/png;base64,b3JpZw==");
    expect(screen.getByAltText("参考图 1")).toHaveAttribute("src", "data:image/png;base64,cmVm");
  });
});
