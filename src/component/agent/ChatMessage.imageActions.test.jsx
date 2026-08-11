/* global chrome */
/* eslint-disable react/prop-types */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, ...props }) => <button type="button" onClick={onPress} {...props}>{children}</button>,
  Dialog: ({ children, trigger }) => <div>{trigger}{children}</div>
}));

import ChatMessage from "./ChatMessage";

Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
  configurable: true,
  value: 1200
});

Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
  configurable: true,
  value: 800
});

Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return {
      width: 960,
      height: 640,
      top: 0,
      left: 0,
      right: 960,
      bottom: 640,
      x: 0,
      y: 0,
      toJSON() {}
    };
  }
});

describe("ChatMessage image actions", () => {
  it("copies the signed URL immediately after uploading", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    await chrome.storage.local.set({
      supabaseConfig: {
        url: "https://demo.supabase.co",
        key: "anon-key",
        bucket: "tabmanager",
        basePath: "tabmanager"
      },
      sessions_index: [{ id: "s_1", updatedAt: 1 }],
      session_s_1: { messages: [] }
    });
    const signedUrl = "https://demo.supabase.co/storage/v1/object/sign/tabmanager/tabmanager/images/s_1/img_1.png?token=signed";
    vi.stubGlobal("fetch", vi.fn(async url => {
      if (String(url).includes("/storage/v1/object/sign/")) {
        return { ok: true, status: 200, json: async () => ({ signedURL: signedUrl.replace("https://demo.supabase.co/storage/v1", "") }) };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    }));
    render(
      <ChatMessage
        msg={{
          role: "user",
          content: [{
            type: "image",
            ref: "img_1",
            source: { type: "base64", media_type: "image/png", data: "dXNlcg==", ref: "img_1" }
          }],
          imageRefs: [{ ref: "img_1", dataUrl: "data:image/png;base64,dXNlcg==" }]
        }}
        sessionId="s_1"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "上传图片到 Supabase" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(signedUrl));
    expect(screen.getByRole("button", { name: "复制图片 URL" })).toBeInTheDocument();
  });

  it("copies an existing uploaded URL instead of uploading again", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const uploadedUrl = "https://demo.supabase.co/storage/v1/object/public/images/s_1/img_1.png";
    render(
      <ChatMessage
        msg={{
          role: "user",
          content: [{
            type: "image",
            ref: "img_1",
            source: { type: "base64", media_type: "image/png", data: "dXNlcg==", ref: "img_1" }
          }],
          imageRefs: [{ ref: "img_1", dataUrl: "data:image/png;base64,dXNlcg==", uploadedUrl }]
        }}
        sessionId="s_1"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "复制图片 URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(uploadedUrl));
  });

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
    expect(within(dialog).getByText("75%")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "原图大小" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "放大图片" }));
    expect(within(dialog).getByText("95%")).toBeInTheDocument();

    const stage = within(dialog).getByRole("img", { name: "用户上传的图片" }).parentElement;
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 160, clientY: 130 });
    expect(within(dialog).getByRole("img", { name: "用户上传的图片" })).toHaveStyle({
      transform: "translate(60px, 30px) scale(0.95)"
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog", { name: "img_9 图片预览" })).not.toBeInTheDocument();
  });

  it("opens preview images in a storage-backed viewer tab", async () => {
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
        sessionId="s_123"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "预览 img_9" }));
    const dialog = screen.getByRole("dialog", { name: "img_9 图片预览" });
    fireEvent.click(within(dialog).getByRole("button", { name: "在新标签中打开图片" }));

    expect(await screen.findByRole("dialog", { name: "img_9 图片预览" })).toBeInTheDocument();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    const createdUrl = chrome.tabs.create.mock.calls.at(-1)[0].url;
    expect(createdUrl).toContain("chrome-extension://test-extension/image-viewer.html?");
    expect(createdUrl).toContain("sessionId=s_123");
    expect(createdUrl).toContain("ref=img_9");
    expect(createdUrl).not.toContain("data:image");
  });

  it("navigates ref-backed preview images with side arrows", () => {
    const imageRefNavigator = vi.fn((ref, direction) => {
      if (ref === "img_9" && direction === "next") {
        return { ref: "img_11", src: "data:image/png;base64,bmV4dA==" };
      }
      return null;
    });

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
        sessionId="s_123"
        imageRefNavigator={imageRefNavigator}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "预览 img_9" }));
    const dialog = screen.getByRole("dialog", { name: "img_9 图片预览" });
    expect(within(dialog).queryByRole("button", { name: "预览上一张 ref 图片" })).not.toBeInTheDocument();
    const nextButton = within(dialog).getByRole("button", { name: "预览下一张 ref 图片" });
    fireEvent.pointerDown(nextButton, { button: 0, pointerId: 1, clientX: 900, clientY: 300 });
    fireEvent.click(nextButton);

    expect(imageRefNavigator).toHaveBeenCalledWith("img_9", "next");
    const nextDialog = screen.getByRole("dialog", { name: "img_11 图片预览" });
    expect(within(nextDialog).getByRole("img", { name: "img_11" })).toHaveAttribute("src", "data:image/png;base64,bmV4dA==");
    expect(within(nextDialog).queryByText("下一张")).not.toBeInTheDocument();
    expect(within(nextDialog).queryByText("上一张")).not.toBeInTheDocument();
  });

  it("opens http preview images directly when no ref is available", () => {
    render(
      <ChatMessage
        msg={{
          role: "user",
          content: "编辑图片：参考网络图片",
          imageEditMeta: {
            kind: "image_edit",
            images: [
              { dataUrl: "https://example.com/reference.png", role: "edit_reference" }
            ]
          }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "预览图片" }));
    const dialog = screen.getByRole("dialog", { name: "图片预览" });
    fireEvent.click(within(dialog).getByRole("button", { name: "在新标签中打开图片" }));

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://example.com/reference.png" });
  });
});
