import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileManager } from "./files";
import { chromeStorageVfs as vfs } from "./utils/chromeStorageVfs";

describe("file manager", () => {
  it("browses folders, reads source as text and links to the project", async () => {
    await vfs.writeJson("/webide/ide_test/.project.json", { id: "ide_test" });
    await vfs.writeFile("/webide/ide_test/main.js", "<script>literal source</script>");
    render(<FileManager />);
    fireEvent.click(await screen.findByRole("button", { name: /📁 webide/ }));
    expect(await screen.findByRole("link", { name: "打开 webide" })).toHaveAttribute("href", "chrome-extension://test-extension/webide-host.html?id=ide_test");
    fireEvent.click(await screen.findByRole("button", { name: /📁 ide_test/ }));
    fireEvent.click(await screen.findByRole("button", { name: /📄 main.js/ }));
    expect(await screen.findByText("<script>literal source</script>")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "根目录" }));
    expect(await screen.findByRole("button", { name: /📁 webide/ })).toBeVisible();
  });
});
