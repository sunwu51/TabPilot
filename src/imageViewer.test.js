import { fireEvent, screen, waitFor } from "@testing-library/dom";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetChromeMock } from "../test/setup";

describe("image viewer page", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"><div class="image-viewer-status">加载中...</div></div>';
    window.history.replaceState(null, "", "/image-viewer.html?sessionId=s_1&ref=img_1");

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
  });

  it("loads session refs and supports navigation, zoom, and dragging", async () => {
    resetChromeMock({
      session_s_1_images: {
        img_1: "data:image/png;base64,b25l",
        img_3: "data:image/png;base64,dGhyZWU=",
        img_2: "data:image/png;base64,dHdv",
        other: "data:image/png;base64,bm8="
      }
    });

    await import("./imageViewer.js");

    const image = await screen.findByRole("img", { name: "img_1" });
    fireEvent.load(image);
    await waitFor(() => expect(screen.getByText("74%")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(screen.getByRole("img", { name: "img_2" })).toHaveAttribute("src", "data:image/png;base64,dHdv");
    expect(screen.getByText("img_2 · 2 / 3")).toBeInTheDocument();
    expect(window.location.href).toContain("ref=img_2");

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("120%")).toBeInTheDocument();

    const stage = screen.getByLabelText("图片预览区域");
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 150, clientY: 125 });
    expect(screen.getByRole("img", { name: "img_2" })).toHaveStyle({
      transform: "translate(50px, 25px) scale(1.2)"
    });
  });

  it("does not constrain the image element size at 100 percent zoom", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "imageViewer.css"), "utf8");
    const imageRule = css.match(/\.image-viewer-img\s*\{[^}]+\}/)?.[0] || "";

    expect(imageRule).not.toContain("max-width");
    expect(imageRule).not.toContain("max-height");
  });
});
