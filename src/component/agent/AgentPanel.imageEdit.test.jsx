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
  Dialog: ({ children }) => <div>{children}</div>,
  Switch: ({ children, isSelected, onChange, ...props }) => (
    <label>
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(event) => onChange?.(event.target.checked)}
        {...props}
      />
      {children}
    </label>
  )
}));

import { ImageEditDialog } from "./AgentPanel";

describe("ImageEditDialog", () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn()
    }));
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,bWFzaw==");
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

  it("starts in annotation mode and appends clicked annotation text to the suggestion", () => {
    render(
      <ImageEditDialog
        request={{
          src: "data:image/png;base64,aGVsbG8=",
          alt: "image",
          maskSupported: true
        }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByAltText("image")).toBeInTheDocument();
    expect(document.querySelector(".image-edit-preview-content")).toBeInTheDocument();

    const imageLayer = document.querySelector(".image-edit-image-layer");
    imageLayer.getBoundingClientRect = vi.fn(() => ({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      right: 210,
      bottom: 120,
      x: 10,
      y: 20,
      toJSON: () => {}
    }));

    fireEvent.click(imageLayer, { clientX: 130, clientY: 73 });
    expect(screen.getByPlaceholderText("描述更改，回车发送")).toBeInTheDocument();
    expect(screen.queryByLabelText("添加标注")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("描述更改，回车发送"), {
      target: { value: "改为咬住树叶" }
    });
    fireEvent.keyDown(screen.getByPlaceholderText("描述更改，回车发送"), { key: "Enter" });

    expect(screen.getByPlaceholderText("输入修改建议")).toHaveValue("1. (x: 60.0%, y: 53.0%) 改为咬住树叶");
    expect(screen.getByText("1", { selector: ".image-edit-annotation-persisted" })).toBeInTheDocument();
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

  it("clears existing mask when switching back to annotation mode", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEditDialog
        request={{
          src: "data:image/png;base64,aGVsbG8=",
          alt: "image",
          maskSupported: true
        }}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );

    const modeSwitch = screen.getByLabelText("切换到蒙版模式");
    fireEvent.click(modeSwitch);
    const canvas = document.querySelector(".image-edit-mask-canvas");
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {}
    }));
    Object.defineProperty(canvas, "width", { configurable: true, value: 100 });
    Object.defineProperty(canvas, "height", { configurable: true, value: 100 });

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 40, pointerId: 1 });
    expect(screen.getByText("清除圈选")).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText("切换到标注模式"));
    expect(screen.getByText("清除圈选")).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("输入修改建议"), {
      target: { value: "edit without mask" }
    });
    fireEvent.click(screen.getByText("确认"));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      suggestion: "edit without mask",
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
