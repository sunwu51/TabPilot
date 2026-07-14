import { describe, expect, it, vi } from "vitest";
import {
  clearSessionKeywords,
  compactSessionMessages,
  createSession,
  deleteSession,
  extractTitle,
  generateSessionId,
  claimSessionLock,
  isSessionLockedByOtherWindow,
  listSessions,
  loadLastActiveSessionId,
  loadLastActiveSessionIdForWindow,
  loadDefaultNewSessionSystemPrompt,
  loadHydratedSession,
  loadSession,
  loadSessionImageStore,
  loadSessionMeta,
  pruneExpiredSessionLocks,
  releaseSessionLock,
  releaseSessionLocksForWindow,
  resetSessionTitle,
  saveLastActiveSessionId,
  saveLastActiveSessionIdForWindow,
  saveDefaultNewSessionSystemPrompt,
  saveSession,
  saveSessionMeta,
  saveSessionQueuedMessages,
  updateSessionTitle,
} from "./sessions";
import { resetChromeMock } from "../../../test/setup";

describe("sessions storage", () => {
  it("generates session IDs with timestamp and random suffix", () => {
    vi.spyOn(Date, "now").mockReturnValue(123456);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(generateSessionId()).toMatch(/^s_123456_/);
  });

  it("creates and lists sessions by startedAt or updatedAt descending", async () => {
    resetChromeMock({
      sessions_index: [
        { id: "old", title: "Old", updatedAt: 10, startedAt: 0 },
        { id: "new", title: "New", updatedAt: 20, startedAt: 30 },
      ]
    });
    vi.spyOn(Date, "now").mockReturnValue(15);

    await createSession("created", "Created");
    const sessions = await listSessions();

    expect(sessions.map(session => session.id)).toEqual(["new", "created", "old"]);
    expect(sessions.find(session => session.id === "created")).toMatchObject({
      title: "Created",
      startedAt: 0,
      manualTitle: false
    });
  });

  it("loads missing session data with safe defaults", async () => {
    expect(await loadSession("missing")).toEqual([]);
    expect(await loadSessionMeta("missing")).toEqual({ systemPrompt: "", plans: [], nextImageRefIndex: 1, contextSummary: null, queuedMessages: [], activeToolNames: [] });
  });

  it("saves messages without replacing existing metadata", async () => {
    resetChromeMock({
      session_a: { systemPrompt: "keep", plans: [{ text: "todo" }], messages: [] },
      sessions_index: [{ id: "a", title: "新会话", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });
    vi.spyOn(Date, "now").mockReturnValue(100);

    await saveSession("a", [{ role: "user", content: "hello" }], "Auto title");

    expect(await loadSession("a")).toEqual([{ role: "user", content: "hello" }]);
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "keep", plans: [{ text: "todo" }], nextImageRefIndex: 1, contextSummary: null, queuedMessages: [], activeToolNames: [] });
    const [entry] = await listSessions();
    expect(entry).toMatchObject({ title: "Auto title", startedAt: 100, updatedAt: 100 });
  });

  it("loads optional context summary metadata", async () => {
    resetChromeMock({
      session_a: {
        messages: [],
        contextSummary: {
          version: 1,
          coveredMessageIndex: 3.7,
          displayMessageIndex: 5.9,
          summary: "  compacted history  ",
          createdAt: 10
        }
      }
    });

    expect(await loadSessionMeta("a")).toEqual({
      systemPrompt: "",
      plans: [],
      nextImageRefIndex: 1,
      queuedMessages: [],
      activeToolNames: [],
      contextSummary: {
        version: 1,
        coveredMessageIndex: 3,
        displayMessageIndex: 5,
        summary: "compacted history",
        createdAt: 10
      }
    });
  });

  it("truncates oversized stored context summary metadata", async () => {
    resetChromeMock({
      session_a: {
        messages: [],
        contextSummary: {
          version: 1,
          coveredMessageIndex: 3,
          summary: "x".repeat(3000),
          createdAt: 10
        }
      }
    });

    const meta = await loadSessionMeta("a");
    expect(meta.contextSummary.summary.length).toBeLessThanOrEqual(2400);
    expect(meta.contextSummary.summary).toContain("摘要已按长度上限截断");
  });

  it("does not recreate a deleted session payload when saving after its index entry is gone", async () => {
    resetChromeMock({
      sessions_index: [{ id: "b", title: "B", updatedAt: 1, startedAt: 1 }]
    });

    await expect(saveSession("a", [{ role: "user", content: "orphan" }], "A")).resolves.toBe(false);

    expect(await loadSession("a")).toEqual([]);
    expect((await listSessions()).map(session => session.id)).toEqual(["b"]);
  });

  it("stores repeated base64 session images out of the main message payload", async () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    resetChromeMock({
      session_a: { systemPrompt: "keep", messages: [] },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });
    vi.spyOn(Date, "now").mockReturnValue(100);

    await saveSession("a", [{
      role: "tool",
      content: "image result",
      displayImageUrl: dataUrl,
      imageRefs: [
        { ref: "img_1", dataUrl },
        { ref: "img_1", dataUrl }
      ]
    }], "A");

    expect(await loadSession("a")).toEqual([{
      role: "tool",
      content: "image result",
      displayImageUrl: "session-image:img_1",
      imageRefs: [
        { ref: "img_1", dataUrl: "session-image:img_1" },
        { ref: "img_1", dataUrl: "session-image:img_1" }
      ]
    }]);
    expect(await loadSessionImageStore("a")).toEqual({ img_1: dataUrl });
    expect(await loadHydratedSession("a")).toEqual([{
      role: "tool",
      content: "image result",
      displayImageUrl: dataUrl,
      imageRefs: [
        { ref: "img_1", dataUrl },
        { ref: "img_1", dataUrl }
      ]
    }]);
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "keep", plans: [], nextImageRefIndex: 2, contextSummary: null, queuedMessages: [], activeToolNames: [] });
  });

  it("stores user image blocks out of the main message payload", async () => {
    resetChromeMock({
      session_a: { messages: [] },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });

    await saveSession("a", [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlcg==" } }
      ]
    }], "A");

    expect(await loadSession("a")).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "session_image", ref: "img_1", media_type: "image/png" } }
      ]
    }]);
    expect(await loadSessionImageStore("a")).toEqual({
      img_1: "data:image/png;base64,dXNlcg=="
    });
    expect(await loadHydratedSession("a")).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          ref: "img_1",
          source: { type: "base64", media_type: "image/png", data: "dXNlcg==", ref: "img_1" }
        }
      ]
    }]);
  });

  it("hydrates large user image blocks without regex stack pressure", () => {
    const imageData = "a".repeat(512 * 1024);
    const dataUrl = `data:image/png;base64,${imageData}`;

    const result = compactSessionMessages([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }
      ]
    }]);

    expect(result.imageStore).toEqual({ img_1: dataUrl });
    expect(result.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "session_image", ref: "img_1", media_type: "image/png" }
    });
  });

  it("keeps canonical image refs aligned across blocks, imageRefs, and image store", () => {
    const result = compactSessionMessages([{
      role: "user",
      imageRefs: [
        { ref: "img_7", dataUrl: "data:image/png;base64,dXNlcg==" }
      ],
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          ref: "img_7",
          source: { type: "base64", media_type: "image/png", data: "dXNlcg==", ref: "img_7" }
        }
      ]
    }]);

    expect(result).toEqual({
      messages: [{
        role: "user",
        imageRefs: [
          { ref: "img_7", dataUrl: "session-image:img_7" }
        ],
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            ref: "img_7",
            source: { type: "session_image", ref: "img_7", media_type: "image/png" }
          }
        ]
      }],
      imageStore: {
        img_7: "data:image/png;base64,dXNlcg=="
      }
    });
  });

  it("garbage-collects orphan imageStore entries that no compacted message references", async () => {
    const dataUrl = "data:image/png;base64,dXNlcg==";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 4 },
      session_a_images: {
        img_1: "data:image/png;base64,b2xkQQ==",
        img_2: "data:image/png;base64,b2xkQg==",
        img_3: "data:image/png;base64,b2xkQw=="
      },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Mirrors autoSave: the in-memory counter (reset to 1 by clearSessionImageState,
    // bumped to 2 after one new ref) is passed as nextImageRefIndex hint.
    await saveSession("a", [{
      role: "user",
      content: [
        { type: "text", text: "fresh start" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlcg==" } }
      ]
    }], "A", { nextImageRefIndex: 1 });

    // Only the freshly referenced image survives; the three orphan entries are swept.
    expect(await loadSessionImageStore("a")).toEqual({ img_1: dataUrl });
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "", plans: [], nextImageRefIndex: 2, contextSummary: null, queuedMessages: [], activeToolNames: [] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("preserves the monotonic nextImageRefIndex when a rewind drops the latest image ref", async () => {
    const img1 = "data:image/png;base64,b25l";
    const img2 = "data:image/png;base64,dHdv";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 4 },
      session_a_images: { img_1: img1, img_2: img2, img_3: "data:image/png;base64,dGhyZWU=" },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Simulate a rewind that removed the message referencing img_3. autoSave
    // passes the in-memory monotonic counter (still 4) as the fallback.
    await saveSession("a", [{
      role: "user",
      imageRefs: [
        { ref: "img_1", dataUrl: "session-image:img_1" },
        { ref: "img_2", dataUrl: "session-image:img_2" }
      ],
      content: [
        { type: "image", ref: "img_1", source: { type: "session_image", ref: "img_1", media_type: "image/png" } },
        { type: "image", ref: "img_2", source: { type: "session_image", ref: "img_2", media_type: "image/png" } }
      ]
    }], "A", { nextImageRefIndex: 4 });

    // img_3 data GC'd, but the counter does not recycle: it stays at 4 so that
    // the next allocation is img_4, not img_3.
    expect(await loadSessionImageStore("a")).toEqual({ img_1: img1, img_2: img2 });
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "", plans: [], nextImageRefIndex: 4, contextSummary: null, queuedMessages: [], activeToolNames: [] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("img_3"));
    warnSpy.mockRestore();
  });

  it("keeps imageStore entries alive that are only reachable through un-hydrated session-image refs", async () => {
    const dataUrl = "data:image/png;base64,dXNlcg==";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 4 },
      session_a_images: { img_3: dataUrl },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });

    // Mirrors the openSession hydrate window: messages still carry session_image
    // and "session-image:" pointers because loadSessionImagesIntoCache has not
    // populated the in-memory cache yet.
    await saveSession("a", [{
      role: "user",
      imageRefs: [{ ref: "img_3", dataUrl: "session-image:img_3" }],
      content: [
        {
          type: "image",
          ref: "img_3",
          source: { type: "session_image", ref: "img_3", media_type: "image/png" }
        }
      ]
    }], "A");

    expect(await loadSessionImageStore("a")).toEqual({ img_3: dataUrl });
  });

  it("keeps imageStore entries alive that are reachable through hydrated image refs", async () => {
    const img1 = "data:image/png;base64,b25l";
    const img2 = "data:image/png;base64,dHdv";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 3 },
      session_a_images: { img_1: img1, img_2: img2 },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await saveSession("a", [{
      role: "user",
      imageRefs: [
        { ref: "img_1", dataUrl: img1 },
        { ref: "img_2", dataUrl: img2 }
      ],
      content: [
        { type: "image", ref: "img_1", source: { type: "base64", media_type: "image/png", data: "b25l", ref: "img_1" } },
        { type: "image", ref: "img_2", source: { type: "base64", media_type: "image/png", data: "dHdv", ref: "img_2" } }
      ]
    }], "A", { nextImageRefIndex: 3 });

    expect(await loadSessionImageStore("a")).toEqual({ img_1: img1, img_2: img2 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("preserves existing image store entries when saving placeholder-only image messages", async () => {
    const dataUrl = "data:image/png;base64,dXNlcg==";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 4 },
      session_a_images: { img_3: dataUrl },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });

    await saveSession("a", [{
      role: "user",
      imageRefs: [{ ref: "img_3", dataUrl: "session-image:img_3" }],
      content: [
        {
          type: "image",
          ref: "img_3",
          source: { type: "session_image", ref: "img_3", media_type: "image/png" }
        }
      ]
    }], "A");

    expect(await loadSessionImageStore("a")).toEqual({ img_3: dataUrl });
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "", plans: [], nextImageRefIndex: 4, contextSummary: null, queuedMessages: [], activeToolNames: [] });
  });

  it("does not garbage-collect session images when saving or clearing queued messages", async () => {
    const historyImage = "data:image/png;base64,aGlzdG9yeQ==";
    const queuedImage = "data:image/png;base64,cXVldWU=";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 3 },
      session_a_images: { img_1: historyImage },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });

    await saveSessionQueuedMessages("a", [{
      role: "user",
      imageRefs: [{ ref: "img_2", dataUrl: queuedImage }],
      content: [
        { type: "text", text: "queued" },
        {
          type: "image",
          ref: "img_2",
          source: { type: "base64", media_type: "image/png", data: "cXVldWU=", ref: "img_2" }
        }
      ]
    }]);

    expect(await loadSessionImageStore("a")).toEqual({
      img_1: historyImage,
      img_2: queuedImage
    });

    await saveSessionQueuedMessages("a", []);

    expect(await loadSessionImageStore("a")).toEqual({
      img_1: historyImage,
      img_2: queuedImage
    });
  });

  it("keeps queued image store entries alive when autosaving active messages", async () => {
    const queuedImage = "data:image/png;base64,cXVldWU=";
    resetChromeMock({
      session_a: { messages: [], nextImageRefIndex: 2 },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });

    await saveSessionQueuedMessages("a", [{
      role: "user",
      imageRefs: [{ ref: "img_1", dataUrl: queuedImage }],
      content: [
        { type: "text", text: "queued" },
        {
          type: "image",
          ref: "img_1",
          source: { type: "base64", media_type: "image/png", data: "cXVldWU=", ref: "img_1" }
        }
      ]
    }]);

    expect(Object.keys(await loadSessionImageStore("a"))).toEqual(["img_1"]);

    await saveSession("a", [{ role: "user", content: "active run" }], "A");

    expect(await loadSessionImageStore("a")).toEqual({ img_1: queuedImage });
    expect((await loadSessionMeta("a")).queuedMessages[0].imageRefs).toEqual([
      { ref: "img_1", dataUrl: "session-image:img_1" }
    ]);
  });

  it("persists nextImageRefIndex so future refs continue increasing after removed messages", async () => {
    resetChromeMock({
      session_a: { messages: [] },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });

    await saveSession("a", [{
      role: "user",
      imageRefs: [{ ref: "img_3", dataUrl: "data:image/png;base64,dXNlcg==" }],
      content: [{
        type: "image",
        ref: "img_3",
        source: { type: "base64", media_type: "image/png", data: "dXNlcg==", ref: "img_3" }
      }]
    }], "A", { nextImageRefIndex: 4 });

    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "", plans: [], nextImageRefIndex: 4, contextSummary: null, queuedMessages: [], activeToolNames: [] });
    expect(await loadSessionImageStore("a")).toEqual({ img_3: "data:image/png;base64,dXNlcg==" });
  });

  it("does not compact base64 data URLs embedded inside text", () => {
    const dataUrl = "data:image/png;base64,d29ybGQ=";

    expect(compactSessionMessages([{
      role: "assistant",
      content: `![image](${dataUrl})`
    }])).toEqual({
      messages: [{
        role: "assistant",
        content: `![image](${dataUrl})`
      }],
      imageStore: undefined
    });
  });

  it("does not overwrite manual titles with automatic titles", async () => {
    resetChromeMock({
      sessions_index: [{ id: "a", title: "Manual", updatedAt: 1, startedAt: 2, manualTitle: true }]
    });
    vi.spyOn(Date, "now").mockReturnValue(100);

    await saveSession("a", [{ role: "user", content: "hello" }], "Auto title");

    const [entry] = await listSessions();
    expect(entry).toMatchObject({ title: "Manual", manualTitle: true, updatedAt: 100 });
  });

  it("stores latest context usage summary in the session index", async () => {
    resetChromeMock({
      sessions_index: [{ id: "a", title: "A", updatedAt: 1, startedAt: 2, manualTitle: false }]
    });

    await saveSession("a", [{ role: "user", content: "hello" }], "A", {
      contextUsage: {
        tokens: 12345,
        usageStatus: "ok",
        apiType: "openai-responses",
        model: "gpt-test",
        usage: { prompt_tokens: 10000, completion_tokens: 2345 }
      }
    });

    const [entry] = await listSessions();
    expect(entry.contextUsage).toEqual({
      tokens: 12345,
      usageStatus: "ok",
      apiType: "openai-responses",
      model: "gpt-test"
    });
  });

  it("updates and resets manual title state", async () => {
    resetChromeMock({
      sessions_index: [{ id: "a", title: "Old", updatedAt: 1, startedAt: 2, manualTitle: false }]
    });

    expect(await updateSessionTitle("a", "  Custom  ")).toBe("Custom");
    expect((await listSessions())[0]).toMatchObject({ title: "Custom", manualTitle: true });

    expect(await resetSessionTitle("a", "")).toBe("新会话");
    expect((await listSessions())[0]).toMatchObject({ title: "新会话", manualTitle: false });
  });

  it("saves metadata without replacing messages", async () => {
    resetChromeMock({
      session_a: { messages: [{ role: "user", content: "hello" }], systemPrompt: "" },
      sessions_index: [{ id: "a", title: "A", updatedAt: 1 }]
    });

    await saveSessionMeta("a", { systemPrompt: "sys", plans: [{ step: "one" }] });

    expect(await loadSession("a")).toEqual([{ role: "user", content: "hello" }]);
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "sys", plans: [{ step: "one" }], nextImageRefIndex: 1, contextSummary: null, queuedMessages: [], activeToolNames: [] });
  });

  it("normalizes persisted active tool names", async () => {
    resetChromeMock({
      session_a: { messages: [], activeToolNames: ["tab_extract", "", "tab_extract", 123] }
    });

    expect((await loadSessionMeta("a")).activeToolNames).toEqual(["tab_extract", "123"]);
  });

  it("clears stored session keywords from the index entry", async () => {
    resetChromeMock({
      sessions_index: [{
        id: "a",
        title: "A",
        updatedAt: 1,
        keywords: ["alpha", "beta"],
        sessionKeywords: ["legacy"],
        keywordMessageIndex: 8,
        keywordsMessageIndex: 7,
        keywordUpdatedAt: 123
      }]
    });
    vi.spyOn(Date, "now").mockReturnValue(200);

    expect(await clearSessionKeywords("a")).toBe(true);
    expect((await listSessions())[0]).toEqual({
      id: "a",
      title: "A",
      updatedAt: 200
    });
  });

  it("deletes session payload and index entry", async () => {
    resetChromeMock({
      session_a: { messages: [{ role: "user", content: "hello" }] },
      session_a_images: { img_1: "data:image/png;base64,aGVsbG8=" },
      sessions_index: [{ id: "a" }, { id: "b" }]
    });

    await deleteSession("a");

    expect(await loadSession("a")).toEqual([]);
    expect(await loadSessionImageStore("a")).toEqual({});
    expect((await listSessions()).map(session => session.id)).toEqual(["b"]);
  });

  it("loads, saves, and clears the last active session id", async () => {
    expect(await loadLastActiveSessionId()).toBe("");

    expect(await saveLastActiveSessionId("a")).toBe("a");
    expect(await loadLastActiveSessionId()).toBe("a");

    expect(await saveLastActiveSessionId("")).toBe("");
    expect(await loadLastActiveSessionId()).toBe("");
  });

  it("loads, saves, and clears the per-window last active session id", async () => {
    expect(await loadLastActiveSessionIdForWindow(7)).toBe("");

    expect(await saveLastActiveSessionIdForWindow(7, "a")).toBe("a");
    expect(await loadLastActiveSessionIdForWindow("7")).toBe("a");

    expect(await saveLastActiveSessionIdForWindow(7, "")).toBe("");
    expect(await loadLastActiveSessionIdForWindow(7)).toBe("");
  });

  it("claims session locks and reports conflicts from other windows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);

    expect(await claimSessionLock("a", 1)).toEqual({ claimed: true, conflict: null });
    expect(await claimSessionLock("a", 1)).toEqual({ claimed: true, conflict: null });

    const conflict = await claimSessionLock("a", 2);
    expect(conflict).toEqual({
      claimed: false,
      conflict: { sessionId: "a", windowId: "1", updatedAt: 1000 }
    });
    expect(await isSessionLockedByOtherWindow("a", 2)).toEqual({
      sessionId: "a",
      windowId: "1",
      updatedAt: 1000
    });
  });

  it("allows expired session locks to be reclaimed", async () => {
    resetChromeMock({
      agent_session_locks: {
        a: { windowId: "1", updatedAt: 1000 }
      }
    });
    vi.spyOn(Date, "now").mockReturnValue(31_001);

    expect(await claimSessionLock("a", 2)).toEqual({ claimed: true, conflict: null });
    expect(await isSessionLockedByOtherWindow("a", 1)).toEqual({
      sessionId: "a",
      windowId: "2",
      updatedAt: 31_001
    });
  });

  it("allows session locks from closed windows to be reclaimed immediately", async () => {
    resetChromeMock({
      agent_session_locks: {
        a: { windowId: "1", updatedAt: 1000 }
      }
    });
    globalThis.chrome.windows.get.mockRejectedValueOnce(new Error("No window with id: 1."));
    vi.spyOn(Date, "now").mockReturnValue(2000);

    expect(await claimSessionLock("a", 2)).toEqual({ claimed: true, conflict: null });
    expect(await isSessionLockedByOtherWindow("a", 1)).toEqual({
      sessionId: "a",
      windowId: "2",
      updatedAt: 2000
    });
  });

  it("clears conflicts from closed windows when checking locks", async () => {
    resetChromeMock({
      agent_session_locks: {
        a: { windowId: "1", updatedAt: 1000 }
      }
    });
    globalThis.chrome.windows.get.mockRejectedValueOnce(new Error("No window with id: 1."));
    vi.spyOn(Date, "now").mockReturnValue(2000);

    expect(await isSessionLockedByOtherWindow("a", 2)).toBeNull();
    expect(await claimSessionLock("a", 2)).toEqual({ claimed: true, conflict: null });
  });

  it("releases session locks only from the owning window", async () => {
    resetChromeMock({
      agent_session_locks: {
        a: { windowId: "1", updatedAt: 1000 }
      }
    });
    vi.spyOn(Date, "now").mockReturnValue(1000);

    await releaseSessionLock("a", 2);
    expect(await isSessionLockedByOtherWindow("a", 2)).toEqual({
      sessionId: "a",
      windowId: "1",
      updatedAt: 1000
    });

    await releaseSessionLock("a", 1);
    expect(await isSessionLockedByOtherWindow("a", 2)).toBeNull();
  });

  it("releases all session locks owned by a window", async () => {
    resetChromeMock({
      agent_session_locks: {
        a: { windowId: "1", updatedAt: 1000 },
        b: { windowId: "2", updatedAt: 1000 },
        c: { windowId: "1", updatedAt: 1000 }
      }
    });
    vi.spyOn(Date, "now").mockReturnValue(1000);

    expect(await releaseSessionLocksForWindow(1)).toBe(2);
    expect(await isSessionLockedByOtherWindow("a", 2)).toBeNull();
    expect(await isSessionLockedByOtherWindow("c", 2)).toBeNull();
    expect(await isSessionLockedByOtherWindow("b", 1)).toEqual({
      sessionId: "b",
      windowId: "2",
      updatedAt: 1000
    });
  });

  it("prunes expired session locks", async () => {
    resetChromeMock({
      agent_session_locks: {
        stale: { windowId: "1", updatedAt: 1000 },
        fresh: { windowId: "2", updatedAt: 30_000 }
      }
    });
    vi.spyOn(Date, "now").mockReturnValue(31_001);

    await pruneExpiredSessionLocks();

    expect(await isSessionLockedByOtherWindow("stale", 3)).toBeNull();
    expect(await isSessionLockedByOtherWindow("fresh", 3)).toEqual({
      sessionId: "fresh",
      windowId: "2",
      updatedAt: 30_000
    });
  });

  it("clears the last active session id when deleting that session", async () => {
    resetChromeMock({
      agent_last_active_session_id: "a",
      session_a: { messages: [{ role: "user", content: "hello" }] },
      sessions_index: [{ id: "a" }, { id: "b" }]
    });

    await deleteSession("a");

    expect(await loadLastActiveSessionId()).toBe("");
  });

  it("cleans lock and per-window last active state when deleting a session", async () => {
    resetChromeMock({
      agent_last_active_session_by_window: { 1: "a", 2: "b" },
      agent_session_locks: {
        a: { windowId: "1", updatedAt: 1000 },
        b: { windowId: "2", updatedAt: 1000 }
      },
      session_a: { messages: [{ role: "user", content: "hello" }] },
      sessions_index: [{ id: "a" }, { id: "b" }]
    });
    vi.spyOn(Date, "now").mockReturnValue(1000);

    await deleteSession("a");

    expect(await loadLastActiveSessionIdForWindow(1)).toBe("");
    expect(await loadLastActiveSessionIdForWindow(2)).toBe("b");
    expect(await isSessionLockedByOtherWindow("a", 2)).toBeNull();
    expect(await isSessionLockedByOtherWindow("b", 1)).toEqual({
      sessionId: "b",
      windowId: "2",
      updatedAt: 1000
    });
  });

  it("loads, saves, and clears default new-session system prompt", async () => {
    expect(await loadDefaultNewSessionSystemPrompt()).toEqual({ sessionId: "", systemPrompt: "" });

    expect(await saveDefaultNewSessionSystemPrompt({ sessionId: "a", systemPrompt: "  sys  " }))
      .toEqual({ sessionId: "a", systemPrompt: "sys" });
    expect(await loadDefaultNewSessionSystemPrompt()).toEqual({ sessionId: "a", systemPrompt: "sys" });

    expect(await saveDefaultNewSessionSystemPrompt({ sessionId: "a", systemPrompt: " " }))
      .toEqual({ sessionId: "", systemPrompt: "" });
  });

  it("extracts title from the first string user message", () => {
    expect(extractTitle([{ role: "assistant", content: "ignore" }])).toBe("新会话");
    expect(extractTitle([{ role: "user", content: "  short title  " }])).toBe("short title");
    expect(extractTitle([{ role: "user", content: "1234567890123456789012345" }])).toBe("12345678901234567890...");
  });

  it("extracts title from user-visible text in structured user messages", () => {
    expect(extractTitle([{
      role: "user",
      content: [
        { type: "text", text: "  structured title  " },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }
      ]
    }])).toBe("structured title");

    expect(extractTitle([{
      role: "user",
      displayContent: "visible title",
      content: [
        { type: "text", text: "internal injected context" }
      ]
    }])).toBe("visible title");

    expect(extractTitle([{
      role: "user",
      content: [
        {
          type: "text",
          text: "image request\n\nAttached image ref: img_1. For any tool argument that requires this image's base64 data URL, pass exactly \"|deRef:img_1|\"."
        }
      ]
    }])).toBe("image request");
  });
});
