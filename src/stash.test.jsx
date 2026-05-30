import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownPreview, normalizeStashMediaSrc } from "./stash";

describe("stash markdown raw html", () => {
  it("renders raw audio and video html with safe http sources", () => {
    render(
      <MarkdownPreview
        markdown={[
          "<audio controls src=\"https://example.com/a.mp3\"></audio>",
          "<video controls src=\"https://example.com/v.mp4\"></video>"
        ].join("\n")}
      />
    );

    const audio = document.querySelector("audio.stash-markdown-audio");
    const video = document.querySelector("video.stash-markdown-video");
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute("src", "https://example.com/a.mp3");
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("src", "https://example.com/v.mp4");
  });

  it("drops unsafe raw media sources", () => {
    render(
      <MarkdownPreview markdown={"<audio controls src=\"javascript:alert(1)\"></audio>"} />
    );

    expect(document.querySelector("audio")).not.toBeInTheDocument();
    expect(normalizeStashMediaSrc("javascript:alert(1)")).toBe("");
  });

  it("continues rendering normal markdown", () => {
    render(<MarkdownPreview markdown={"# Title\n\n- item"} />);

    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("item")).toBeInTheDocument();
  });
});
