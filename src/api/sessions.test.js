import { describe, expect, it, vi } from "vitest";
import {
  createSession,
  deleteSession,
  extractTitle,
  generateSessionId,
  listSessions,
  loadLastActiveSessionId,
  loadDefaultNewSessionSystemPrompt,
  loadSession,
  loadSessionMeta,
  resetSessionTitle,
  saveLastActiveSessionId,
  saveDefaultNewSessionSystemPrompt,
  saveSession,
  saveSessionMeta,
  updateSessionTitle,
} from "./sessions";
import { resetChromeMock } from "../../test/setup";

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

  it("deletes session payload and index entry", async () => {
    resetChromeMock({
      session_a: { messages: [{ role: "user", content: "hello" }] },
      sessions_index: [{ id: "a" }, { id: "b" }]
    });

    await deleteSession("a");

    expect(await loadSession("a")).toEqual([]);
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
});
