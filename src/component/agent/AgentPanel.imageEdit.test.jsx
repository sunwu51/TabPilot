/* eslint-disable react/prop-types */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

let resolveReferenceImage;

vi.mock("./panel/messages/userMessage", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    imageFileToAttachmentItem: vi.fn(() => new Promise(resolve => {
      resolveReferenceImage = resolve;
    }))
  };
});

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, isDisabled, ...props }) => (
    <button type="button" onClick={onPress} disabled={isDisabled} {...props}>{children}</button>
  ),
  Card: ({ children }) => <div>{children}</div>,
  Dialog: ({ children }) => <div>{children}</div>
}));

import { ImageEditDialog } from "./AgentPanel";

describe("ImageEditDialog", () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn()
    }));
  });

  it("hides local mask controls when mask is unsupported", () => {
    render(
      <ImageEditDialog
        request={{
          src: "data:image/png;base64,aGVsbG8=",
          alt: "image",
          maskSupported: false
        }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.queryByText("局部修改")).not.toBeInTheDocument();
    expect(screen.queryByText("清除圈选")).not.toBeInTheDocument();
  });

  it("does not submit mask data when mask is unsupported", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEditDialog
        request={{
          src: "data:image/png;base64,aGVsbG8=",
          alt: "image",
          maskSupported: false
        }}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("输入修改建议"), {
      target: { value: "add a hat" }
    });
    fireEvent.click(screen.getByText("确认"));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      suggestion: "add a hat",
      maskDataUrl: ""
    }));
  });

  it("disables confirm while reference images are still processing", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEditDialog
        request={{
          src: "data:image/png;base64,aGVsbG8=",
          alt: "image",
          maskSupported: false
        }}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("输入修改建议"), {
      target: { value: "use this reference" }
    });
    fireEvent.change(document.querySelector(".image-edit-reference-input"), {
      target: {
        files: [new File(["fake"], "reference.png", { type: "image/png" })]
      }
    });

    const confirmButton = screen.getByText("处理中...");
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();

    resolveReferenceImage?.({
      id: "att_ref",
      type: "image",
      dataUrl: "data:image/png;base64,cmVm",
      mediaType: "image/png",
      fileName: "reference.png"
    });
  });
});
