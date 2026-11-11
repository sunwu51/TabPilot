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
    expect(await screen.findByRole("heading", { name: "File Manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Directory navigation" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Plain text viewer" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("File Manager");
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
