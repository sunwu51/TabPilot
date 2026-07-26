/* global chrome */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetChromeMock } from "../../test/setup";

describe("macro recorder IME input", () => {
  let activateRecorderIfNeeded;

  afterEach(async () => {
    if (activateRecorderIfNeeded) {
      resetChromeMock();
      await activateRecorderIfNeeded();
    }
    document.body.innerHTML = "";
    vi.resetModules();
  });

  it("records the committed IME text before an immediate button click", async () => {
    vi.useFakeTimers();
    resetChromeMock({
      macroRecording: {
        tabId: 7,
        draft: { name: "Search", workflow: { steps: [] } }
      }
    });
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback?.(message.type === "macro_get_my_tab_id" ? { tabId: 7 } : { success: true });
    });
    ({ activateRecorderIfNeeded } = await import("./recorder"));

    document.body.innerHTML = '<input id="search"><button id="submit">Search</button>';
    await activateRecorderIfNeeded();

    const input = document.querySelector("#search");
    const button = document.querySelector("#submit");
    input.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    input.value = "ni";
    const composingInput = new Event("input", { bubbles: true });
    Object.defineProperty(composingInput, "isComposing", { value: true });
    input.dispatchEvent(composingInput);
    await vi.advanceTimersByTimeAsync(300);

    input.value = "你";
    input.dispatchEvent(new Event("compositionend", { bubbles: true }));
    button.click();

    const steps = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.type === "macro_record_step")
      .map(message => message.step);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ type: "input", value: "你" });
    expect(steps[1]).toMatchObject({ type: "click" });
  });
});
