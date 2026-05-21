/* eslint-disable react/prop-types */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, ...props }) => <button type="button" onClick={onPress} {...props}>{children}</button>,
  Dialog: ({ children, trigger }) => <div>{trigger}{children}</div>
}));

import ChatMessage from "./ChatMessage";

describe("ChatMessage image actions", () => {
  it("opens an in-page preview dialog from the ref button and supports zoom controls", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "预览 img_9" }));

    const dialog = screen.getByRole("dialog", { name: "img_9 图片预览" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByAltText("用户上传的图片")).toHaveAttribute("src", "data:image/png;base64,dXNlcg==");
    expect(within(dialog).getAllByText("100%").length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "适应窗口" }));
    expect(within(dialog).getByText("98%")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "重置缩放" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "放大图片" }));
    expect(within(dialog).getByText("118%")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog", { name: "img_9 图片预览" })).not.toBeInTheDocument();
  });
});
