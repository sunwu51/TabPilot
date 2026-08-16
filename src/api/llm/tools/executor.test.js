/* global chrome */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, getBuiltinToolTimeoutSeconds, openHelloWorldPlayground } from "./executor";

vi.mock("../../mcp", () => ({
  callMcpTool: vi.fn(async (url, headers, name, args, timeoutMs) => ({
    url,
    headers,
    name,
    args,
    timeoutMs
  }))
}));

vi.mock("./builtins/downloadHelper", () => ({
  triggerBrowserDownload: vi.fn(async (args) => ({ success: true, ...args, downloadId: 42 })),
  hasDownloadsPermission: vi.fn(async () => true),
  downloadsPermissionRequiredError: () => ({
    error: "downloads permission not granted",
    code: "downloads_permission_required",
    permission: "downloads"
  })
}));

describe("built-in tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a stable error for unknown tools", async () => {
    await expect(executeTool("missing_tool", {})).resolves.toEqual({ error: "Unknown tool: missing_tool" });
  });

  it("creates interaction snapshots and reuses refs for DOM actions", async () => {
    document.body.innerHTML = `
      <label for="email">Email address</label>
      <input id="email" type="email" placeholder="name@example.com">
      <button type="submit">Sign in</button>
    `;
    document.querySelectorAll("input, button").forEach(element => {
      element.scrollIntoView = vi.fn();
    });
    chrome.tabs.get.mockResolvedValue({ id: 41, windowId: 2, url: "https://example.com/login" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 41, includeHidden: true });

    expect(snapshot).toMatchObject({
      success: true,
      tabId: 41,
      snapshotId: expect.stringMatching(/^snap_/),
      count: 2
    });
    expect(snapshot).not.toHaveProperty("nodes");
    expect(snapshot.content).toContain(`- group\n  - text: "Email address"\n  - textbox "Email address" [selector="@${snapshot.snapshotId}#e1"]`);
    expect(snapshot.content).toContain(`  - button "Sign in" [selector="@${snapshot.snapshotId}#e2"]`);

    const filled = await executeTool("dom_set_value", {
      tabId: 41,
      selector: `@${snapshot.snapshotId}#e1`,
      value: "user@example.com"
    });
    expect(filled).toMatchObject({ success: true, value: "user@example.com", target: { ref: "e1" } });
    expect(document.getElementById("email").value).toBe("user@example.com");

    const cssFilled = await executeTool("dom_set_value", {
      tabId: 41,
      selector: "#email",
      value: "css@example.com"
    });
    expect(cssFilled).toMatchObject({ success: true, value: "css@example.com" });
    expect(document.getElementById("email").value).toBe("css@example.com");

    await expect(executeTool("dom_click", {
      tabId: 41,
      selector: "@snap_old#e2"
    })).resolves.toMatchObject({ error: "stale_snapshot" });
  });

  it("hovers, focuses, and selects options through DOM tools", async () => {
    document.body.innerHTML = `
      <button id="menu">Menu</button>
      <select aria-label="Country">
        <option value="cn">China</option>
        <option value="us">United States</option>
      </select>
    `;
    document.querySelectorAll("button, select").forEach(element => {
      element.scrollIntoView = vi.fn();
      element.getBoundingClientRect = () => ({ width: 100, height: 20, x: 10, y: 20, top: 20, left: 10, right: 110, bottom: 40 });
    });
    const hoverEvents = [];
    document.getElementById("menu").addEventListener("mouseover", () => hoverEvents.push("mouseover"));
    document.getElementById("menu").addEventListener("mouseenter", () => hoverEvents.push("mouseenter"));
    const changeHandler = vi.fn();
    document.querySelector("select").addEventListener("change", changeHandler);
    chrome.tabs.get.mockResolvedValue({ id: 48, windowId: 2, url: "https://example.com/form" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 48, includeHidden: true });
    const selectSelector = snapshot.content.match(/combobox[^\n]*\[selector="([^"]+)"/)?.[1];
    expect(selectSelector).toBeTruthy();
    const hovered = await executeTool("dom_hover", { tabId: 48, selector: `@${snapshot.snapshotId}#e1` });
    expect(hovered).toMatchObject({ success: true, action: "hover", synthetic: true, target: { ref: "e1" } });
    expect(hoverEvents).toEqual(["mouseover", "mouseenter"]);

    const focused = await executeTool("dom_focus", { tabId: 48, selector: selectSelector });
    expect(focused).toMatchObject({ success: true, action: "focus", focused: true });
    expect(document.activeElement).toBe(document.querySelector("select"));

    const selected = await executeTool("dom_select_option", {
      tabId: 48,
      selector: selectSelector,
      values: ["United States"]
    });
    expect(selected).toMatchObject({ success: true, action: "select_option", values: ["us"], labels: ["United States"] });
    expect(changeHandler).toHaveBeenCalledOnce();

    await expect(executeTool("dom_select_option", {
      tabId: 48,
      selector: selectSelector,
      values: ["missing"]
    })).resolves.toMatchObject({ error: "Options not found: missing" });
  });

  it("supports deep DOM queries, contenteditable, check, scroll, and waits", async () => {
    document.body.innerHTML = '<div id="host"></div><div id="editor" contenteditable="true"></div><input id="flag" type="checkbox">';
    const shadow = document.getElementById("host").attachShadow({ mode: "open" });
    shadow.innerHTML = '<button class="deep">Shadow action</button>';
    document.querySelectorAll("#editor, #flag").forEach(element => { element.scrollIntoView = vi.fn(); });
    shadow.querySelector("button").scrollIntoView = vi.fn();
    chrome.tabs.get.mockResolvedValue({ id: 49, windowId: 2, url: "https://example.com/deep" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const query = await executeTool("dom_query", { tabId: 49, selector: ".deep" });
    expect(query).toMatchObject({ success: true, count: 1, matches: [{ text: "Shadow action" }] });
    await expect(executeTool("dom_set_value", { tabId: 49, selector: "#editor", value: "Hello editor" }))
      .resolves.toMatchObject({ success: true, value: "Hello editor" });
    await expect(executeTool("dom_check", { tabId: 49, selector: "#flag", checked: true }))
      .resolves.toMatchObject({ success: true, checked: true, changed: true });
    await expect(executeTool("dom_scroll_into_view", { tabId: 49, selector: ".deep" }))
      .resolves.toMatchObject({ success: true, action: "scroll_into_view" });
    await expect(executeTool("dom_wait", { tabId: 49, selector: "#flag", state: "enabled", timeoutMs: 100 }))
      .resolves.toMatchObject({ success: true, state: "enabled" });
    await expect(executeTool("dom_wait", { tabId: 49, selector: ".missing", state: "absent", timeoutMs: 100 }))
      .resolves.toMatchObject({ success: true, state: "absent", target: null });
  });

  it("routes navigation and URL waits to an explicit tab", async () => {
    chrome.tabs.get.mockResolvedValue({ id: 74, windowId: 4, url: "https://example.com/next" });
    chrome.tabs.reload.mockResolvedValue();
    chrome.tabs.goBack.mockResolvedValue();
    chrome.tabs.goForward.mockResolvedValue();

    await expect(executeTool("tab_reload", { tabId: 74 })).resolves.toMatchObject({ success: true, action: "reload", tabId: 74 });
    await expect(executeTool("tab_back", { tabId: 74 })).resolves.toMatchObject({ success: true, action: "back", tabId: 74 });
    await expect(executeTool("tab_forward", { tabId: 74 })).resolves.toMatchObject({ success: true, action: "forward", tabId: 74 });
    await expect(executeTool("tab_wait", { tabId: 74, url: "/next", timeoutMs: 100 }))
      .resolves.toMatchObject({ success: true, action: "wait_url", tabId: 74 });
    expect(chrome.tabs.reload).toHaveBeenCalledWith(74);
    expect(chrome.tabs.goBack).toHaveBeenCalledWith(74);
    expect(chrome.tabs.goForward).toHaveBeenCalledWith(74);
  });

  it("keeps article text and card context without assigning refs to static content", async () => {
    document.body.innerHTML = `
      <main>
        <article>
          <h1>Snapshot design</h1>
          <p>Static article text explains the feature.</p>
          <pre>const enabled = true;</pre>
        </article>
        <section><h2>Project A</h2><button aria-label="Delete">Delete</button></section>
        <section><h2>Project B</h2><button aria-label="Delete">Delete</button></section>
      </main>
    `;
    chrome.tabs.get.mockResolvedValue({ id: 42, windowId: 2, url: "https://example.com/projects" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 42, includeHidden: true });
    expect(snapshot.count).toBe(2);

    expect(snapshot.content).toContain('- main\n  - article\n    - heading [level=1]\n      - text: "Snapshot design"');
    expect(snapshot.content).toContain('    - paragraph\n      - text: "Static article text explains the feature."');
    expect(snapshot.content).toContain('    - code\n      - text: "const enabled = true;"');
    expect(snapshot.content).toContain(`  - region\n    - heading [level=2]\n      - text: "Project A"\n    - button "Delete" [selector="@${snapshot.snapshotId}#e1"]`);
    expect(snapshot.content).toContain(`  - region\n    - heading [level=2]\n      - text: "Project B"\n    - button "Delete" [selector="@${snapshot.snapshotId}#e2"]`);
  });

  it("preserves iframe and nested document boundaries in snapshot content", async () => {
    document.body.innerHTML = '<main><h1>Checkout</h1><iframe title="Payment" src="https://example.com/payment"></iframe></main>';
    const iframe = document.querySelector("iframe");
    const frameDocument = document.implementation.createHTMLDocument("Secure payment");
    frameDocument.body.innerHTML = '<h2>Card details</h2><button>Confirm payment</button>';
    Object.defineProperty(frameDocument, "URL", { value: "https://example.com/payment" });
    Object.defineProperty(iframe, "contentDocument", { value: frameDocument });
    const frameButton = frameDocument.querySelector("button");
    frameButton.scrollIntoView = vi.fn();
    const clickHandler = vi.fn();
    frameButton.addEventListener("click", clickHandler);
    chrome.tabs.get.mockResolvedValue({ id: 50, windowId: 2, url: "https://example.com/checkout" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 50, includeHidden: true });
    expect(snapshot.content).toContain(
      '- iframe "Payment" [src="https://example.com/payment"]\n' +
      '    - document "Secure payment" [url="https://example.com/payment"]\n' +
      '      - heading [level=2]\n' +
      '        - text: "Card details"'
    );
    expect(snapshot.content).toContain(`      - button "Confirm payment" [selector="@${snapshot.snapshotId}#e1"]`);

    await expect(executeTool("dom_click", { tabId: 50, selector: `@${snapshot.snapshotId}#e1` }))
      .resolves.toMatchObject({ success: true, target: { ref: "e1" } });
    expect(clickHandler).toHaveBeenCalledOnce();
  });

  it("preserves table row and cell structure around actions", async () => {
    document.body.innerHTML = `
      <table><tbody>
        <tr><td>Project A</td><td><button>Delete</button></td></tr>
        <tr><td>Project B</td><td><button>Delete</button></td></tr>
      </tbody></table>
    `;
    chrome.tabs.get.mockResolvedValue({ id: 43, windowId: 2, url: "https://example.com/table" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 43, includeHidden: true });
    expect(snapshot.content).toContain(`- table\n  - rowgroup\n    - row\n      - cell\n        - text: "Project A"\n      - cell\n        - button "Delete" [selector="@${snapshot.snapshotId}#e1"]`);
  });

  it("enforces per-text and total snapshot character limits", async () => {
    const cards = Array.from({ length: 40 }, (_, index) => `
      <section><h2>Project ${index}</h2><p>${"x".repeat(300)}</p><button>Delete ${index}</button></section>
    `).join("");
    document.body.innerHTML = `<main>${cards}</main>`;
    chrome.tabs.get.mockResolvedValue({ id: 44, windowId: 2, url: "https://example.com/large" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", {
      tabId: 44,
      includeHidden: true,
      maxTextLength: 80,
      maxSnapshotChars: 4000
    });

    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(4000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncation).toMatchObject({ text: true, sizeLimit: true });
    expect(snapshot.limits).toEqual({ maxResults: 500, maxTextLength: 80, maxSnapshotChars: 4000 });
    const textLines = snapshot.content.split("\n").filter(line => line.includes("- text: "));
    expect(textLines.every(line => JSON.parse(line.slice(line.indexOf(":") + 1).trim()).length <= 80)).toBe(true);
    expect(snapshot.count).toBeLessThan(40);
  });

  it("formats control states directly in snapshot content", async () => {
    document.body.innerHTML = `
      <form>
        <input type="checkbox" aria-label="Notifications" checked required>
        <input aria-label="Account" value="alice" readonly>
        <button aria-label="Advanced" aria-expanded="false" disabled></button>
      </form>
    `;
    chrome.tabs.get.mockResolvedValue({ id: 46, windowId: 2, url: "https://example.com/settings" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 46, includeHidden: true });
    expect(snapshot).not.toHaveProperty("nodes");
    expect(snapshot.content).toContain(`- checkbox "Notifications" [selector="@${snapshot.snapshotId}#e1", checked, required]`);
    expect(snapshot.content).toContain(`- textbox "Account" [selector="@${snapshot.snapshotId}#e2", readonly, value="alice"]`);
    expect(snapshot.content).toContain(`- button "Advanced" [selector="@${snapshot.snapshotId}#e3", disabled, expanded=false]`);
  });

  it("flattens meaningless wrappers while preserving list and card hierarchy", async () => {
    document.body.innerHTML = `
      <main>
        <div class="layout"><div><span><b></b></span></div></div>
        <div class="shell"><span><b>Workspace</b></span></div>
        <div class="list-wrapper"><div class="inner">
          <ul>
            <li>
              <div><span><b>Project Alpha</b></span></div>
              <div><span>Running</span></div>
              <div><button>Open</button><span><button aria-label="Delete Project Alpha"></button></span></div>
            </li>
            <li style="display:none"><span>Hidden Project</span><button>Open</button></li>
            <li>
              <div><span>Project Beta</span></div>
              <div><input aria-label="Project name" value="Beta" required></div>
            </li>
          </ul>
        </div></div>
      </main>
    `;
    document.body.getBoundingClientRect = () => ({ width: 800, height: 600, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600 });
    document.querySelectorAll("main, div, span, b, ul, li, button, input").forEach(element => {
      if (!element.style.display) element.getBoundingClientRect = () => ({ width: 100, height: 20, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20 });
    });
    chrome.tabs.get.mockResolvedValue({ id: 47, windowId: 2, url: "https://example.com/workspace" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 47, includeHidden: false });
    expect(snapshot.content).toBe([
      "- main",
      "  - text: \"Workspace\"",
      "  - list",
      "    - listitem",
      "      - text: \"Project Alpha\"",
      "      - text: \"Running\"",
      `      - button "Open" [selector="@${snapshot.snapshotId}#e1"]`,
      "        - text: \"Open\"",
      `      - button "Delete Project Alpha" [selector="@${snapshot.snapshotId}#e2"]`,
      "    - listitem",
      "      - text: \"Project Beta\"",
      `      - textbox "Project name" [selector="@${snapshot.snapshotId}#e3", required, value="Beta"]`
    ].join("\n"));
  });

  it("omits hidden and empty ordinary elements from snapshot content", async () => {
    document.body.innerHTML = `
      <main>
        <p></p><div><span></span><b></b></div>
        <p style="display:none">Hidden paragraph</p>
        <p>Visible paragraph</p>
        <button aria-label="Icon action"></button>
      </main>
    `;
    document.body.getBoundingClientRect = () => ({ width: 100, height: 100, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100 });
    document.querySelector("main").getBoundingClientRect = () => ({ width: 100, height: 100, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100 });
    document.querySelectorAll("p, button").forEach(element => {
      if (!element.style.display) element.getBoundingClientRect = () => ({ width: 50, height: 20, x: 0, y: 0, top: 0, left: 0, right: 50, bottom: 20 });
    });
    chrome.tabs.get.mockResolvedValue({ id: 45, windowId: 2, url: "https://example.com/visibility" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 45 });
    expect(snapshot.content).toContain('paragraph\n    - text: "Visible paragraph"');
    expect(snapshot.content).toContain(`button "Icon action" [selector="@${snapshot.snapshotId}#e1"]`);
    expect(snapshot.content).not.toContain("Hidden paragraph");
    expect(snapshot.content).not.toMatch(/\b(span|b|div)\b/);
  });

  it("keeps visible descendants inside zero-sized containers", async () => {
    document.body.innerHTML = `
      <main>
        <div id="portal-root">
          <button aria-label="Open menu">Open</button>
        </div>
      </main>
    `;
    document.body.getBoundingClientRect = () => ({ width: 100, height: 100, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100 });
    document.querySelector("main").getBoundingClientRect = () => ({ width: 100, height: 100, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100 });
    document.querySelector("button").getBoundingClientRect = () => ({ width: 50, height: 20, x: 0, y: 0, top: 0, left: 0, right: 50, bottom: 20 });
    chrome.tabs.get.mockResolvedValue({ id: 49, windowId: 2, url: "https://example.com/zero-sized-container" });
    chrome.scripting.executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);

    const snapshot = await executeTool("tab_snapshot", { tabId: 49 });
    expect(snapshot.content).toContain(`button "Open menu" [selector="@${snapshot.snapshotId}#e1"]`);
    expect(snapshot.content).toContain('text: "Open"');
  });

  it("runs eval_js against an explicitly selected tab", async () => {
    chrome.tabs.get.mockResolvedValue({ id: 73, windowId: 4, url: "https://example.com/app" });
    chrome.scripting.executeScript.mockResolvedValue([{ result: {
      success: true,
      strategy: "function",
      url: "https://example.com/app",
      title: "App",
      result: 2
    } }]);

    await expect(executeTool("eval_js", { tabId: 73, jsScript: "return 1 + 1" }))
      .resolves.toMatchObject({ success: true, tabId: 73, result: 2 });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 73 },
      world: "MAIN"
    }));
  });

  it("routes MCP names to MCP registry tools", async () => {
    const { callMcpTool } = await import("../../mcp");
    chrome.storage.local.get.mockResolvedValueOnce({ mcpToolTimeoutSeconds: 2 });

    const result = await executeTool("mcp_docs_lookup", { query: "tabs" }, [
      {
        name: "lookup",
        _toolCallName: "mcp_docs_lookup",
        _serverUrl: "https://mcp.example/rpc",
        _serverHeaders: { Authorization: "Bearer token" }
      }
    ]);

    expect(callMcpTool).toHaveBeenCalledWith(
      { type: "http", url: "https://mcp.example/rpc", headers: { Authorization: "Bearer token" } },
      { Authorization: "Bearer token" },
      "lookup",
      { query: "tabs" },
      2000
    );
    expect(result).toMatchObject({ name: "lookup", args: { query: "tabs" } });
  });

  it("routes extension-backed MCP tools with the extension endpoint descriptor", async () => {
    const { callMcpTool } = await import("../../mcp");
    chrome.storage.local.get.mockResolvedValueOnce({ mcpToolTimeoutSeconds: 2 });

    await executeTool("mcp_cookie_helper_get_cookie", { url: "https://example.com", name: "sid" }, [
      {
        name: "get_cookie",
        _toolCallName: "mcp_cookie_helper_get_cookie",
        _serverName: "cookie_helper",
        _serverType: "extension",
        _serverExtensionId: "cookie-helper-id",
        _serverHeaders: {}
      }
    ]);

    expect(callMcpTool).toHaveBeenCalledWith(
      { type: "extension", extensionId: "cookie-helper-id", name: "cookie_helper" },
      {},
      "get_cookie",
      { url: "https://example.com", name: "sid" },
      2000
    );
  });

  it("uses a longer timeout for image tools", () => {
    expect(getBuiltinToolTimeoutSeconds("image_gen")).toBe(900);
    expect(getBuiltinToolTimeoutSeconds("image_edit")).toBe(900);
    expect(getBuiltinToolTimeoutSeconds("tab_list")).toBe(10);
  });

  it("rejects namespaced MCP aliases outside the canonical call-name format", async () => {
    const { callMcpTool } = await import("../../mcp");
    chrome.storage.local.get.mockResolvedValueOnce({ mcpToolTimeoutSeconds: 2 });

    const result = await executeTool("mcp__mcpcenter__tavily_tavily_search", { query: "tabs" }, [
      {
        name: "tavily_tavily-search",
        _serverName: "mcpcenter",
        _toolCallName: "mcp_mcpcenter_tavily_tavily-search",
        _serverUrl: "https://mcp.example/rpc",
        _serverHeaders: { Authorization: "Bearer token" }
      }
    ]);

    expect(result).toMatchObject({ error: "Unknown tool: mcp__mcpcenter__tavily_tavily_search" });
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("routes run_macro with flat arguments to the macro manager", async () => {
    chrome.runtime.sendMessage.mockImplementationOnce((message, callback) => {
      callback({ success: true, tabId: 9, report: { ok: true } });
    });

    const result = await executeTool("run_macro", {
      id: "macro-1",
      inputValues: { input_1: "hello" },
      speed: "fast",
      stepDelayMs: "25"
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "macro_manager",
      action: "replay",
      payload: {
        id: "macro-1",
        inputValues: { input_1: "hello" },
        options: { speed: "fast", stepDelayMs: 25 }
      }
    }, expect.any(Function));
    expect(result).toEqual({ tabId: 9, report: { ok: true } });
  });

  it("validates run_macro id", async () => {
    await expect(executeTool("run_macro", {})).resolves.toEqual({ error: "id is required" });
  });

  it("routes list_macros and describe_macro through macro manager", async () => {
    chrome.runtime.sendMessage
      .mockImplementationOnce((message, callback) => callback({ success: true, data: [{ id: "a" }] }))
      .mockImplementationOnce((message, callback) => callback({ success: true, data: { id: "a" } }));

    await expect(executeTool("list_macros", { query: "foo" })).resolves.toEqual({ macros: [{ id: "a" }] });
    await expect(executeTool("describe_macro", { id: "a" })).resolves.toEqual({ macro: { id: "a" } });

    expect(chrome.runtime.sendMessage.mock.calls[0][0]).toEqual({
      type: "macro_manager",
      action: "list_for_ai",
      payload: { query: "foo" }
    });
    expect(chrome.runtime.sendMessage.mock.calls[1][0]).toEqual({
      type: "macro_manager",
      action: "describe_for_ai",
      payload: { id: "a" }
    });
  });

  it("routes Postdog tools through the Postdog manager", async () => {
    chrome.runtime.sendMessage
      .mockImplementationOnce((message, callback) => callback({ success: true, data: [{ id: "req-1" }] }))
      .mockImplementationOnce((message, callback) => callback({ success: true, data: { response: { status: 200 } } }));

    await expect(executeTool("postdog_list_requests", { query: "foo" })).resolves.toEqual({ requests: [{ id: "req-1" }] });
    await expect(executeTool("postdog_run_request", { id: "req-1" })).resolves.toEqual({ result: { response: { status: 200 } } });

    expect(chrome.runtime.sendMessage.mock.calls[0][0]).toEqual({
      type: "postdog_manager",
      action: "list_requests_for_ai",
      payload: { query: "foo" }
    });
    expect(chrome.runtime.sendMessage.mock.calls[1][0]).toEqual({
      type: "postdog_manager",
      action: "run_request",
      payload: { id: "req-1" }
    });
  });

  it("delegates download execution to download helper", async () => {
    const { triggerBrowserDownload } = await import("./builtins/downloadHelper");

    await expect(executeTool("download", { fileName: "a.txt", content: "hello" }))
      .resolves.toMatchObject({ success: true, fileName: "a.txt", content: "hello", downloadId: 42 });
    expect(triggerBrowserDownload).toHaveBeenCalledWith({ fileName: "a.txt", content: "hello", mimeType: undefined });
  });

  it("passes optional mimeType for content downloads", async () => {
    const { triggerBrowserDownload } = await import("./builtins/downloadHelper");

    await expect(executeTool("download", {
      fileName: "report.md",
      content: "# Report",
      mimeType: "text/markdown;charset=utf-8"
    })).resolves.toMatchObject({
      success: true,
      fileName: "report.md",
      content: "# Report",
      mimeType: "text/markdown;charset=utf-8",
      downloadId: 42
    });
    expect(triggerBrowserDownload).toHaveBeenCalledWith({
      fileName: "report.md",
      content: "# Report",
      mimeType: "text/markdown;charset=utf-8"
    });
  });

  it("creates a storage-backed html_playground project", async () => {
    const result = await executeTool("html_playground", {
      html: "<h1>Hello</h1>",
      css: "h1{color:red}",
      js: "document.body.dataset.ready='1'",
      expanded: true
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringContaining("chrome-extension://test-extension/playground-host.html?"),
      active: true
    });
    const createdUrl = new URL(chrome.tabs.create.mock.calls.at(-1)[0].url);
    expect(createdUrl.searchParams.get("id")).toBe(result.playgroundId);
    expect(createdUrl.searchParams.get("expanded")).toBe("1");
    expect(result).toMatchObject({
      success: true,
      playgroundId: expect.stringMatching(/^pg_/),
      files: [
        `/playgrounds/${result.playgroundId}/index.html`,
        `/playgrounds/${result.playgroundId}/style.css`,
        `/playgrounds/${result.playgroundId}/script.js`
      ],
      revision: 1,
      expireAt: expect.any(Number),
      tabId: 1,
      expanded: true
    });
  });

  it("reads and incrementally edits playground files through the generic VFS tools", async () => {
    const created = await executeTool("html_playground", { css: "one\ntwo\nthree" });
    const path = `/playgrounds/${created.playgroundId}/style.css`;
    await expect(executeTool("vfs_read_file", {
      path,
      startLine: 2,
      endLine: 2
    })).resolves.toMatchObject({
      content: "two",
      startLine: 2,
      endLine: 2,
      lineCount: 3,
      revision: 1
    });

    await expect(executeTool("vfs_edit_file", {
      path,
      startLine: 2,
      endLine: 2,
      expectedRevision: 1,
      originalContent: "two",
      newContent: "changed\ninserted"
    })).resolves.toMatchObject({ success: true, startLine: 2, endLine: 2, lineCount: 4, revision: 2 });

    await expect(executeTool("vfs_read_file", {
      path
    })).resolves.toMatchObject({ content: "one\nchanged\ninserted\nthree", lineCount: 4, revision: 2 });
  });

  it("creates a multi-file React WebIDE project", async () => {
    const result = await executeTool("webide_project", { template: "react", name: "Tool WebIDE" });

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringContaining("chrome-extension://test-extension/webide-host.html?"),
      active: true
    });
    expect(result).toMatchObject({
      success: true,
      projectId: expect.stringMatching(/^ide_/),
      template: "react",
      rootPath: expect.stringMatching(/^\/webide\/ide_/),
      entry: "src/main.jsx",
      files: expect.arrayContaining([
        expect.stringMatching(/\/index\.html$/),
        expect.stringMatching(/\/src\/App\.jsx$/),
        expect.stringMatching(/\/src\/main\.jsx$/)
      ]),
      expireAt: expect.any(Number),
      tabId: 1
    });
  });

  it("creates arbitrary text files through the generic VFS write tool", async () => {
    await expect(executeTool("vfs_write_file", {
      path: "/notes/report.md",
      content: "# Report",
      expectedRevision: 0
    })).resolves.toMatchObject({ success: true, path: "/notes/report.md", revision: 1 });

    await expect(executeTool("vfs_read_file", { path: "/notes/report.md" }))
      .resolves.toMatchObject({
        success: true,
        content: "# Report",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
        revision: 1
      });
  });

  it("rejects VFS line edits when original content does not match", async () => {
    await executeTool("vfs_write_file", { path: "/notes/conflict.md", content: "first\nsecond", expectedRevision: 0 });

    await expect(executeTool("vfs_edit_file", {
      path: "/notes/conflict.md",
      startLine: 1,
      endLine: 2,
      expectedRevision: 1,
      originalContent: "first\nstale",
      newContent: "changed"
    })).resolves.toMatchObject({ error: expect.stringContaining("Lines 1-2 content does not match") });
  });

  it("opens hello world playground from settings helper", async () => {
    const result = await openHelloWorldPlayground();

    const createdUrl = new URL(chrome.tabs.create.mock.calls.at(-1)[0].url);
    expect(createdUrl.pathname).toBe("/playground-host.html");
    expect(createdUrl.searchParams.get("id")).toBe(result.playgroundId);
    expect(createdUrl.searchParams.get("expanded")).toBe("1");
    expect(result).toMatchObject({ success: true, tabId: 1, expanded: true });
  });

  it("calls the configured Image API generation endpoint and returns multiple data URLs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { b64_json: "aGVsbG8=", revised_prompt: "A revised prompt" },
        { b64_json: "d29ybGQ=" }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        size: "1024x1024",
        quality: "low"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "generations",
        model: "gpt-image-2",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        imageCount: 2,
        revisedPrompt: "A revised prompt",
        images: [
          { dataUrl: "data:image/png;base64,aGVsbG8=", outputFormat: "png", revisedPrompt: "A revised prompt" },
          { dataUrl: "data:image/png;base64,d29ybGQ=", outputFormat: "png" }
        ]
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer img-token" })
        })
      );
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        model: "gpt-image-2",
        prompt: "Draw a cat",
        size: "1024x1024",
        quality: "low"
      });
      expect(body.b64_json).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses image_model_id to select a configured Image API profile", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { b64_json: "aW1n" }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        activeImageModelId: "img_default",
        imageModels: [
          {
            id: "img_default",
            name: "Default image",
            imageBaseUrl: "https://default.example/v1",
            imageApiKey: "default-token",
            imageApiProtocol: "generate",
            imageModel: "default-image-model"
          },
          {
            id: "img_alt01",
            name: "Alt image",
            imageBaseUrl: "https://alt.example/v1",
            imageApiKey: "alt-token",
            imageApiProtocol: "generate",
            imageModel: "alt-image-model"
          }
        ]
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        image_model_id: "img_alt01"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "generations",
        model: "alt-image-model",
        imageModelId: "img_alt01",
        imageModelName: "alt-image-model",
        dataUrl: "data:image/png;base64,aW1n"
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://alt.example/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer alt-token" })
        })
      );
      expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).model).toBe("alt-image-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("calls the configured chat/completions image endpoint and reads OpenRouter-style images", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "Generated",
            images: [
              { image_url: { url: "data:image/png;base64,aGVsbG8=" } }
            ]
          }
        }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://openrouter.ai/api/v1",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "google/gemini-2.5-flash-image-preview"
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        size: "1024x1024"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "chat_completions",
        model: "google/gemini-2.5-flash-image-preview",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        imageCount: 1
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer img-token"
          })
        })
      );
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        model: "google/gemini-2.5-flash-image-preview",
        modalities: ["image", "text"],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Draw a cat" }
            ]
          }
        ],
        size: "1024x1024"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores free-form image model overrides from tool args", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "configured-image-model"
      }
    });

    try {
      const result = await executeTool("image_gen", {
        prompt: "Draw a cat",
        model: "made-up-model"
      });

      expect(result).toMatchObject({
        success: true,
        model: "configured-image-model"
      });
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.model).toBe("configured-image-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("calls the configured Image API edit endpoint with multipart image and mask", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1/images/generations",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        image: "data:image/png;base64,aGVsbG8=",
        mask: "data:image/png;base64,aGVsbG8=",
        output_format: "webp"
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "edits",
        dataUrl: "data:image/webp;base64,aGVsbG8=",
        inputImageCount: 1,
        maskApplied: true
      });
      expect(globalThis.fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
      const init = globalThis.fetch.mock.calls[0][1];
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Bearer img-token" });
      const entries = Array.from(init.body.entries());
      expect(entries.find(([key]) => key === "prompt")?.[1]).toBe("Add a hat");
      expect(entries.find(([key]) => key === "model")?.[1]).toBe("gpt-image-2");
      expect(entries.find(([key]) => key === "output_format")?.[1]).toBe("webp");
      expect(entries.find(([key]) => key === "image[]")?.[1]).toBeInstanceOf(File);
      expect(entries.find(([key]) => key === "mask")?.[1]).toBeInstanceOf(File);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts ordered image arrays for Image API edits", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Use the second image as a style reference",
        images: [
          "data:image/png;base64,aGVsbG8=",
          "data:image/png;base64,d29ybGQ="
        ]
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "edits",
        inputImageCount: 2
      });
      const entries = Array.from(globalThis.fetch.mock.calls[0][1].body.entries());
      expect(entries.filter(([key]) => key === "image[]")).toHaveLength(2);
      expect(entries.find(([key]) => key === "mask")).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends edit images through chat/completions image_url content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            images: [
              { type: "image_url", image_url: { url: "https://example.com/generated.png" } }
            ]
          }
        }
      ]
    }), { status: 200 }));
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "google/gemini-2.5-flash-image-preview"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        images: [
          "data:image/png;base64,aGVsbG8=",
          "https://example.com/ref.png"
        ]
      });

      expect(result).toMatchObject({
        success: true,
        endpoint: "chat_completions",
        inputImageCount: 2,
        imageUrl: "https://example.com/generated.png"
      });
      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "Add a hat" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        { type: "image_url", image_url: { url: "https://example.com/ref.png" } }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports mask as unsupported for chat/completions image edits", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://openrouter.ai/api/v1",
        imageApiKey: "img-token",
        imageApiProtocol: "chat_completions",
        imageModel: "google/gemini-2.5-flash-image-preview"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        image: "data:image/png;base64,aGVsbG8=",
        mask: "data:image/png;base64,aGVsbG8="
      });

      expect(result).toEqual({
        error: "mask is not supported by the chat/completions image protocol"
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unresolved local image refs before calling the Image API", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    await chrome.storage.local.set({
      llmConfig: {
        imageBaseUrl: "https://api.openai.com/v1",
        imageApiKey: "img-token",
        imageModel: "gpt-image-2"
      }
    });

    try {
      const result = await executeTool("image_edit", {
        prompt: "Add a hat",
        image: "data:image/png;base64,aGVsbG8=",
        mask: "\"|deRef:img_2|\""
      });

      expect(result).toMatchObject({
        error: "mask ref img_2 was not resolved before image tool execution"
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes recent downloads", async () => {
    chrome.downloads.search.mockResolvedValueOnce([
      { id: 1, url: "https://example.com/a", filename: "C:\\Downloads\\a.txt", state: "complete", totalBytes: 3 }
    ]);

    await expect(executeTool("download_list", { limit: 1 })).resolves.toEqual({
      count: 1,
      downloads: [expect.objectContaining({
        id: 1,
        filename: "C:\\Downloads\\a.txt",
        state: "complete",
        totalBytes: 3
      })]
    });
    expect(chrome.downloads.search).toHaveBeenCalledWith({ limit: 1, orderBy: ["-startTime"] });
  });

  it("builds download search filters", async () => {
    chrome.downloads.search.mockResolvedValueOnce([]);

    const result = await executeTool("download_search", {
      query: "foo bar",
      state: "complete",
      startedAfter: 1000,
      startedBefore: 2000,
      limit: 2
    });

    expect(result.query).toMatchObject({
      query: ["foo", "bar"],
      state: "complete",
      startedAfter: new Date(1000).toISOString(),
      startedBefore: new Date(2000).toISOString(),
      limit: 2
    });
  });

  it("validates sleep duration without waiting", async () => {
    vi.useFakeTimers();
    const promise = executeTool("sleep", { seconds: 1 });
    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toMatchObject({ success: true, requestedSeconds: 1 });
    await expect(executeTool("sleep", { seconds: 0 })).resolves.toEqual({
      error: "seconds must be an integer between 1 and 300 (inclusive)"
    });
  });

  it("supports wait as the code-mode sleep tool", async () => {
    vi.useFakeTimers();
    const promise = executeTool("wait", { seconds: 1 });
    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toMatchObject({ success: true, requestedSeconds: 1 });
  });
});
