import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileManager } from "./files";
import { chromeStorageVfs as vfs } from "./utils/chromeStorageVfs";
import { LocaleProvider } from "./i18n";

describe("file manager", () => {
  it("browses folders, reads source as text and links to the project", async () => {
    await vfs.writeJson("/webide/ide_test/.project.json", { id: "ide_test" });
    await vfs.writeFile("/webide/ide_test/main.js", "<script>literal source</script>");
    render(<FileManager />);
    fireEvent.click(await screen.findByRole("button", { name: /📁 webide/ }));
    expect(await screen.findByRole("link", { name: "打开 WebIDE" })).toHaveAttribute("href", "chrome-extension://test-extension/webide-host.html?id=ide_test");
    fireEvent.click(await screen.findByRole("button", { name: /📁 ide_test/ }));
    fireEvent.click(await screen.findByRole("button", { name: /📄 main.js/ }));
    expect(await screen.findByText("<script>literal source</script>")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "根目录" }));
    expect(await screen.findByRole("button", { name: /📁 webide/ })).toBeVisible();
  });

  it("uses the saved English locale for navigation, project links and source viewer", async () => {
    await chrome.storage.local.set({ uiLocale: "en" });
    await vfs.writeJson("/playgrounds/pg_test/.project.json", { id: "pg_test" });
    await vfs.writeFile("/playgrounds/pg_test/index.html", "中文用户内容");
    render(<LocaleProvider><FileManager /></LocaleProvider>);
    expect(await screen.findByRole("heading", { name: "file manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Directory navigation" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Plain text viewer" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("file manager");
    fireEvent.click(await screen.findByRole("button", { name: /📁 playgrounds/ }));
    expect(await screen.findByRole("link", { name: "Open Playground" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /📁 pg_test/ }));
    fireEvent.click(await screen.findByRole("button", { name: /📄 index.html/ }));
    expect(await screen.findByText("中文用户内容")).toBeVisible();
    expect(screen.getByText(/Plain text · revision/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Root" }));
    expect(await screen.findByRole("button", { name: /📁 playgrounds/ })).toBeVisible();
  });
});

describe("file manager scripts", () => {
  it("runs a saved script in the chosen tab and shows the result", async () => {
    await vfs.writeFile("/scripts/title.js", "return document.title;");
    await vfs.writeFile("/notes/readme.js", "not a script");
    chrome.tabs.query.mockResolvedValue([
      { id: 5, url: "https://a.example.com/", title: "Older", lastAccessed: 1 },
      { id: 7, url: "https://git.example.com/mr/1", title: "MR 1", lastAccessed: 9 },
      { id: 8, url: "chrome://extensions/", title: "Extensions", lastAccessed: 99 },
    ]);
    chrome.tabs.get.mockImplementation(async id => ({ id, url: "https://git.example.com/mr/1", windowId: 1, groupId: -1 }));
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: { success: true, strategy: "sval", result: { title: "MR 1" } } }]);

    render(<FileManager />);
    fireEvent.click(await screen.findByRole("button", { name: /📁 scripts/ }));
    fireEvent.click(await screen.findByRole("button", { name: /📄 title.js/ }));

    const picker = await screen.findByRole("combobox", { name: "运行于" });
    await screen.findByRole("option", { name: /MR 1/ });
    expect(picker).toHaveValue("7");
    expect(screen.queryByRole("option", { name: /Extensions/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /参数 args/ }), { target: { value: '{"n":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "运行脚本" }));
    expect(await screen.findByLabelText("运行结果")).toHaveTextContent('"title": "MR 1"');
    expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 7 },
      args: ["return document.title;", '{"n":1}']
    }));
  });

  it("offers no run bar for files outside /scripts", async () => {
    await vfs.writeFile("/notes/readme.js", "not a script");
    render(<FileManager />);
    fireEvent.click(await screen.findByRole("button", { name: /📁 notes/ }));
    fireEvent.click(await screen.findByRole("button", { name: /📄 readme.js/ }));
    expect(await screen.findByText("not a script")).toBeVisible();
    expect(screen.queryByRole("button", { name: "运行脚本" })).not.toBeInTheDocument();
  });
});
