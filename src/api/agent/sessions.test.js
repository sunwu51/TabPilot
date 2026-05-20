import { describe, expect, it, vi } from "vitest";
import {
  clearSessionKeywords,
  compactSessionMessages,
  createSession,
  deleteSession,
  extractTitle,
  generateSessionId,
  listSessions,
  loadLastActiveSessionId,
  loadDefaultNewSessionSystemPrompt,
  loadHydratedSession,
  loadSession,
  loadSessionImageStore,
  loadSessionMeta,
  resetSessionTitle,
  saveLastActiveSessionId,
  saveDefaultNewSessionSystemPrompt,
  saveSession,
  saveSessionMeta,
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
    expect(await loadSessionMeta("missing")).toEqual({ systemPrompt: "", plans: [] });
  });

  it("saves messages without replacing existing metadata", async () => {
    resetChromeMock({
      session_a: { systemPrompt: "keep", plans: [{ text: "todo" }], messages: [] },
      sessions_index: [{ id: "a", title: "新会话", updatedAt: 1, startedAt: 0, manualTitle: false }]
    });
    vi.spyOn(Date, "now").mockReturnValue(100);

    await saveSession("a", [{ role: "user", content: "hello" }], "Auto title");

    expect(await loadSession("a")).toEqual([{ role: "user", content: "hello" }]);
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "keep", plans: [{ text: "todo" }] });
    const [entry] = await listSessions();
    expect(entry).toMatchObject({ title: "Auto title", startedAt: 100, updatedAt: 100 });
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
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "keep", plans: [] });
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
        { type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlcg==" } }
      ]
    }]);
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
    expect(await loadSessionMeta("a")).toEqual({ systemPrompt: "sys", plans: [{ step: "one" }] });
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

  it("clears the last active session id when deleting that session", async () => {
    resetChromeMock({
      agent_last_active_session_id: "a",
      session_a: { messages: [{ role: "user", content: "hello" }] },
      sessions_index: [{ id: "a" }, { id: "b" }]
    });

    await deleteSession("a");

    expect(await loadLastActiveSessionId()).toBe("");
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
