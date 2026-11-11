/* global chrome */
/* eslint-disable react/prop-types */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sunwu51/camel-ui", () => ({
  Card: ({ children }) => <div>{children}</div>,
}));

import StickyBoard from "./StickyBoard";
import { BOARD_KEY } from "../../api/sticky/store";

const liveTab = { id: 7, windowId: 1, active: true, url: "https://git.example.com/mr/1", title: "MR 1", status: "complete" };

function seed(notes, lanes = []) {
  return chrome.storage.local.set({ [BOARD_KEY]: { version: 1, lanes, notes } });
}

function note(overrides = {}) {
  return {
    id: "n1", url: "https://git.example.com/mr/1", pinnedUrl: "https://git.example.com/mr/1", title: "MR 1",
    customTitle: "", note: "", favIconUrl: "", laneId: null, tabId: 7, hasThumb: false, done: false, ...overrides,
  };
}

afterEach(cleanup);

describe("StickyBoard", () => {
  it("shows an empty state, then sticks the current tab", async () => {
    chrome.tabs.query.mockResolvedValue([liveTab]);
    render(<StickyBoard />);
    await screen.findByText("把正在处理的页面贴在这里，稍后一键回来。");

    fireEvent.click(screen.getByRole("button", { name: /贴住当前页/ }));
    const card = await screen.findByTestId("sticky-card");
    expect(card).toHaveClass("is-live");
    expect(card).toHaveTextContent("MR 1");
    expect(card).toHaveTextContent("git.example.com");
  });

  it("greys out a note whose tab is closed and reopens it on click", async () => {
    await seed([note()]);
    chrome.tabs.query.mockResolvedValue([]);
    chrome.tabs.get.mockRejectedValue(new Error("No tab"));
    chrome.tabs.create.mockResolvedValue({ id: 40, windowId: 1 });
    render(<StickyBoard />);

    const card = await screen.findByTestId("sticky-card");
    await waitFor(() => expect(card).toHaveClass("is-dead"));
    expect(card).toHaveTextContent("已关闭");

    fireEvent.click(screen.getByRole("button", { name: /MR 1/ }));
    await waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://git.example.com/mr/1", active: true }));
    await waitFor(() => expect(screen.getByTestId("sticky-card")).toHaveClass("is-live"));
  });

  it("renames a note and filters by lane", async () => {
    await seed(
      [note(), note({ id: "n2", title: "Kafka console", url: "https://mq.example.com/", tabId: 8, laneId: "l1" })],
      [{ id: "l1", name: "中间件", color: "blue" }]
    );
    chrome.tabs.query.mockResolvedValue([liveTab, { id: 8, windowId: 1, url: "https://mq.example.com/", title: "Kafka console", status: "complete" }]);
    render(<StickyBoard />);

    await waitFor(() => expect(screen.getAllByTestId("sticky-card")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /中间件/ }));
    await waitFor(() => expect(screen.getAllByTestId("sticky-card")).toHaveLength(1));
    expect(screen.getByTestId("sticky-card")).toHaveClass("stk-c-blue");

    fireEvent.click(screen.getByRole("button", { name: "改标题" }));
    const input = screen.getByRole("textbox", { name: "便利贴标题" });
    fireEvent.change(input, { target: { value: "队列排查" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("sticky-card")).toHaveTextContent("队列排查"));
  });
});

describe("StickyBoard lanes and ordering", () => {
  it("uses the default colour without a lane and moves a note through the lane menu", async () => {
    await seed([note()], [{ id: "l1", name: "MR review", color: "pink" }]);
    chrome.tabs.query.mockResolvedValue([liveTab]);
    render(<StickyBoard />);

    const card = await screen.findByTestId("sticky-card");
    expect(card).toHaveClass("stk-c-sky");

    fireEvent.click(screen.getByRole("button", { name: "移动到分组" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /MR review/ }));
    await waitFor(() => expect(screen.getByTestId("sticky-card")).toHaveClass("stk-c-pink"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("reorders notes by dragging one onto another", async () => {
    await seed([note(), note({ id: "n2", title: "Kafka console", url: "https://mq.example.com/", tabId: 8 })]);
    chrome.tabs.query.mockResolvedValue([liveTab, { id: 8, windowId: 1, url: "https://mq.example.com/", title: "Kafka console", status: "complete" }]);
    render(<StickyBoard />);
    await waitFor(() => expect(screen.getAllByTestId("sticky-card")).toHaveLength(2));

    const slots = () => screen.getAllByTestId("sticky-card").map(card => card.parentElement);
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(slots()[0], { dataTransfer });
    await waitFor(() => expect(slots()[0]).toHaveClass("is-dragging"));
    fireEvent.dragOver(slots()[1], { dataTransfer });
    fireEvent.dragEnd(slots()[1], { dataTransfer });

    await waitFor(async () => {
      const stored = (await chrome.storage.local.get(BOARD_KEY))[BOARD_KEY];
      expect(stored.notes.map(item => item.id)).toEqual(["n2", "n1"]);
    });
    expect(screen.getAllByTestId("sticky-card")[0]).toHaveTextContent("Kafka console");
  });
});
