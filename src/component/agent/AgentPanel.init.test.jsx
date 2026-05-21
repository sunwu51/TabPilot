/* eslint-disable react/prop-types */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, isDisabled, ...props }) => (
    <button type="button" onClick={onPress} disabled={isDisabled} {...props}>{children}</button>
  ),
  Card: ({ children }) => <div>{children}</div>,
  Dialog: ({ children, trigger }) => (
    <div>
      {trigger || null}
      {children}
    </div>
  )
}));

vi.mock("react-hot-toast", () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}));

vi.mock("./McpConfig", () => ({ default: () => null }));
vi.mock("./UserProfilePanel", () => ({ default: () => null }));
vi.mock("./SkillsConfig", () => ({ default: () => null }));

import AgentPanel from "./AgentPanel";
import { resetChromeMock } from "../../../test/setup";

describe("AgentPanel initial session restore", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  });

  it("hydrates stored session images when restoring the last active session on mount", async () => {
    const dataUrl = "data:image/png;base64,dXNlcg==";
    resetChromeMock({
      sessions_index: [{
        id: "a",
        title: "图片会话",
        updatedAt: 1,
        startedAt: 1,
        manualTitle: false
      }],
      agent_last_active_session_id: "a",
      session_a: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "请看图片" },
            { type: "image", source: { type: "session_image", ref: "img_1", media_type: "image/png" } }
          ]
        }]
      },
      session_a_images: {
        img_1: dataUrl
      }
    });
    chrome.runtime.getPlatformInfo = vi.fn((callback) => {
      callback?.({ os: "mac" });
      return Promise.resolve({ os: "mac" });
    });

    render(<AgentPanel />);

    const image = await screen.findByAltText("用户上传的图片");
    await waitFor(() => {
      expect(image).toHaveAttribute("src", dataUrl);
    });
    expect(screen.queryByText("图片加载中...")).not.toBeInTheDocument();
  });
});
