/* global chrome */
import { describe, expect, it } from "vitest";
import {
  DONE_RETENTION_MS,
  addLane,
  applyOrder,
  loadBoard,
  openNote,
  pinTab,
  pinUrl,
  reconcileBoard,
  reconcileStickies,
  removeLane,
  removeNote,
  reorderNotes,
  setNoteDone,
  splitExpiredDone,
  thumbKey,
} from "./store";

function note(overrides = {}) {
  return { id: "n1", url: "https://git.example.com/mr/1", title: "MR 1", tabId: 7, done: false, ...overrides };
}

function tab(overrides = {}) {
  return { id: 7, windowId: 1, url: "https://git.example.com/mr/1", title: "MR 1", status: "complete", ...overrides };
}

describe("reconcileBoard", () => {
  it("follows same-origin navigation of the bound tab", () => {
    const { board, changed } = reconcileBoard(
      { notes: [note()] },
      [tab({ url: "https://git.example.com/mr/1/diffs", title: "MR 1 · Changes" })]
    );
    expect(changed).toBe(true);
    expect(board.notes[0]).toMatchObject({ tabId: 7, url: "https://git.example.com/mr/1/diffs", title: "MR 1 · Changes" });
  });

  it("detaches when the tab closes or leaves the origin, keeping the last URL", () => {
    expect(reconcileBoard({ notes: [note()] }, []).board.notes[0].tabId).toBeNull();
    const away = reconcileBoard({ notes: [note()] }, [tab({ url: "https://sso.example.org/login" })]);
    expect(away.board.notes[0]).toMatchObject({ tabId: null, url: "https://git.example.com/mr/1" });
  });

  it("keeps the binding while the tab is still blank", () => {
    const { board, changed } = reconcileBoard({ notes: [note()] }, [tab({ url: "", pendingUrl: "" })]);
    expect(changed).toBe(false);
    expect(board.notes[0].tabId).toBe(7);
  });

  it("re-binds a detached note to an open tab with the same URL, ignoring the hash", () => {
    const { board } = reconcileBoard(
      { notes: [note({ tabId: null })] },
      [tab({ id: 22, url: "https://git.example.com/mr/1#note_5" })]
    );
    expect(board.notes[0].tabId).toBe(22);
  });

  it("never binds two notes to one tab", () => {
    const { board } = reconcileBoard(
      { notes: [note({ id: "a", tabId: null }), note({ id: "b", tabId: null })] },
      [tab({ id: 22 })]
    );
    expect(board.notes.map(item => item.tabId)).toEqual([22, null]);
  });

  it("drops stale tab ids in a fresh browser session before matching by URL", () => {
    const { board } = reconcileBoard(
      { notes: [note({ tabId: 7 })] },
      [tab({ id: 7, url: "https://git.example.com/mr/999" }), tab({ id: 8 })],
      { freshSession: true }
    );
    expect(board.notes[0]).toMatchObject({ tabId: 8, url: "https://git.example.com/mr/1" });
  });

  it("does not track finished notes", () => {
    const { board } = reconcileBoard({ notes: [note({ done: true })] }, [tab()]);
    expect(board.notes[0].tabId).toBeNull();
  });
});

describe("sticky store", () => {
  it("pins a tab once and reports duplicates", async () => {
    const first = await pinTab(tab({ active: false }));
    expect(first.duplicate).toBe(false);
    expect(first.note).toMatchObject({ tabId: 7, url: "https://git.example.com/mr/1", pinnedUrl: "https://git.example.com/mr/1", hasThumb: false });

    const second = await pinTab(tab({ active: false }));
    expect(second.duplicate).toBe(true);
    expect((await loadBoard()).notes).toHaveLength(1);
  });

  it("focuses a live tab and revives a closed one", async () => {
    const { note: pinned } = await pinTab(tab({ active: false }));
    expect(await openNote(pinned.id)).toEqual({ revived: false });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });

    chrome.tabs.query.mockResolvedValueOnce([]);
    await reconcileStickies();
    expect((await loadBoard()).notes[0].tabId).toBeNull();

    chrome.tabs.create.mockResolvedValueOnce({ id: 31, windowId: 2 });
    expect(await openNote(pinned.id)).toEqual({ revived: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://git.example.com/mr/1", active: true });
    expect((await loadBoard()).notes[0].tabId).toBe(31);
  });

  it("assigns lane colours, and removing a lane keeps its notes", async () => {
    const review = await addLane("MR review");
    const signkey = await addLane("signkey");
    expect(review.color).not.toBe(signkey.color);

    const { note: pinned } = await pinTab(tab({ active: false }), { laneId: review.id });
    expect(pinned.laneId).toBe(review.id);

    await removeLane(review.id);
    const board = await loadBoard();
    expect(board.lanes.map(lane => lane.name)).toEqual(["signkey"]);
    expect(board.notes[0].laneId).toBeNull();
  });

  it("marks notes done and deletes them with their thumbnail", async () => {
    const { note: pinned } = await pinTab(tab({ active: false }));
    await chrome.storage.local.set({ [thumbKey(pinned.id)]: "data:image/jpeg;base64,AA" });

    await setNoteDone(pinned.id, true);
    expect((await loadBoard()).notes[0]).toMatchObject({ done: true, tabId: null });

    await removeNote(pinned.id);
    expect((await loadBoard()).notes).toHaveLength(0);
    expect((await chrome.storage.local.get(thumbKey(pinned.id)))[thumbKey(pinned.id)]).toBeUndefined();
  });
});

describe("applyOrder", () => {
  it("reorders only the listed notes and leaves the others in their slots", () => {
    const notes = ["a", "x", "b", "c", "y"].map(id => ({ id }));
    expect(applyOrder(notes, ["c", "a", "b"]).map(item => item.id)).toEqual(["c", "x", "a", "b", "y"]);
  });

  it("persists a new order", async () => {
    const first = await pinTab(tab({ id: 1, active: false, url: "https://a.example.com/" }));
    const second = await pinTab(tab({ id: 2, active: false, url: "https://b.example.com/" }));
    expect((await loadBoard()).notes.map(item => item.id)).toEqual([second.note.id, first.note.id]);
    await reorderNotes([first.note.id, second.note.id]);
    expect((await loadBoard()).notes.map(item => item.id)).toEqual([first.note.id, second.note.id]);
  });
});

describe("finished notes", () => {
  it("stamps doneAt and clears it on restore", async () => {
    const { note: pinned } = await pinTab(tab({ active: false }));
    await setNoteDone(pinned.id, true);
    expect((await loadBoard()).notes[0].doneAt).toEqual(expect.any(Number));
    await setNoteDone(pinned.id, false);
    expect((await loadBoard()).notes[0]).toMatchObject({ done: false, doneAt: null });
  });

  it("expires only notes finished more than three days ago", () => {
    const now = 10 * DONE_RETENTION_MS;
    const { kept, expired } = splitExpiredDone([
      { id: "old", done: true, doneAt: now - DONE_RETENTION_MS - 1 },
      { id: "recent", done: true, doneAt: now - DONE_RETENTION_MS + 60000 },
      { id: "legacy", done: true, updatedAt: now - 2 * DONE_RETENTION_MS },
      { id: "open", done: false, createdAt: 0 },
    ], now);
    expect(expired.map(item => item.id)).toEqual(["old", "legacy"]);
    expect(kept.map(item => item.id)).toEqual(["recent", "open"]);
  });

  it("deletes expired notes and their thumbnails during reconcile", async () => {
    const { note: pinned } = await pinTab(tab({ active: false }));
    await chrome.storage.local.set({ [thumbKey(pinned.id)]: "data:image/jpeg;base64,AA" });
    await setNoteDone(pinned.id, true);
    await reconcileStickies();
    expect((await loadBoard()).notes).toHaveLength(1);

    const board = await loadBoard();
    board.notes[0].doneAt = Date.now() - DONE_RETENTION_MS - 1000;
    await chrome.storage.local.set({ stickyBoard: board });
    await reconcileStickies();
    expect((await loadBoard()).notes).toHaveLength(0);
    expect((await chrome.storage.local.get(thumbKey(pinned.id)))[thumbKey(pinned.id)]).toBeUndefined();
  });
});

describe("pinUrl", () => {
  it("creates a closed note for a link with no open tab, once", async () => {
    const first = await pinUrl("https://git.example.com/mr/9", { title: "MR 9" });
    expect(first).toMatchObject({ duplicate: false, note: { tabId: null, title: "MR 9", url: "https://git.example.com/mr/9", hasThumb: false } });
    expect((await pinUrl("https://git.example.com/mr/9#note_1")).duplicate).toBe(true);
    expect((await loadBoard()).notes).toHaveLength(1);
  });

  it("sticks the open tab when one already shows that URL", async () => {
    chrome.tabs.query.mockResolvedValue([tab({ id: 12, active: false })]);
    const result = await pinUrl("https://git.example.com/mr/1");
    expect(result).toMatchObject({ duplicate: false, note: { tabId: 12, title: "MR 1" } });
    expect((await pinUrl("https://git.example.com/mr/1")).duplicate).toBe(true);
  });

  it("rejects things that are not web addresses", async () => {
    await expect(pinUrl("javascript:alert(1)")).rejects.toThrow("BAD_URL");
    await expect(pinUrl("just some text")).rejects.toThrow("BAD_URL");
  });
});
