import { describe, expect, it } from "vitest";
import { buildWebIdePreview, buildWebIdeShareUrl } from "./webIdeShare";
import { inflateStringFromQueryParam } from "./playgroundCodec";

const transform = async ({ code }) => code;
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文 &amp; logo</text></svg>';

function project(overrides = {}) {
  return {
    entry: "src/main.js", transform,
    files: {
      "index.html": '<html><head><link rel="stylesheet" href="./src/style.css"></head><body><img src="assets/logo.svg"><img src="https://example.com/remote.png"><div id="app"></div></body></html>',
      "src/main.js": 'import logo from "../assets/logo.svg"; import "./style.css"; document.querySelector("#app").textContent = logo;',
      "src/style.css": 'body { background: url("../assets/logo.svg"); }',
      "assets/logo.svg": svg,
      ...overrides
    }
  };
}

describe("WebIDE share snapshots", () => {
  it("inlines SVG imports, HTML images and CSS URLs while preserving external resources", async () => {
    const html = await buildWebIdePreview(project());
    const doc = new DOMParser().parseFromString(html, "text/html");
    const images = doc.querySelectorAll("img");
    expect(decodeURIComponent(images[0].src.split(",")[1])).toBe(svg);
    expect(images[1].src).toBe("https://example.com/remote.png");
    const css = decodeURIComponent(doc.querySelector("link").href.split(",").slice(1).join(","));
    expect(css).toContain("data:image/svg+xml");
    const map = JSON.parse(doc.querySelector('script[type="importmap"]').textContent);
    const assetModule = decodeURIComponent(map.imports["webide:assets/logo.svg"].split(",").slice(1).join(","));
    expect(assetModule).toContain("export default \"data:image/svg+xml");
    const cssModule = decodeURIComponent(map.imports["webide:src/style.css"].split(",").slice(1).join(","));
    expect(cssModule).toContain("data:image/svg+xml");
  });

  it("round-trips the complete document through the public Playground format", async () => {
    const html = await buildWebIdePreview(project({ "src/main.js": 'document.querySelector("#app").textContent = "你好 </script> &";' }));
    const url = new URL(buildWebIdeShareUrl(html));
    const params = new URLSearchParams(url.hash.slice(1));
    expect(url.origin + url.pathname).toBe("https://sunwu51.github.io/HtmlPlayground/");
    expect(params.get("expanded")).toBe("0");
    expect(inflateStringFromQueryParam(params.get("js"))).toBe("");
    const wrapper = new DOMParser().parseFromString(inflateStringFromQueryParam(params.get("html")), "text/html");
    expect(wrapper.querySelector("iframe").getAttribute("srcdoc")).toBe(html);
    expect(wrapper.querySelector("iframe").getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("places the import map before project modules and retains dependency mappings", async () => {
    const html = await buildWebIdePreview(project({
      "index.html": '<html><head><script type="module" src="src/main.js"></script></head><body></body></html>',
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1" } })
    }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.head.firstChild.type).toBe("importmap");
    expect(JSON.parse(doc.head.firstChild.textContent).imports.react).toBe("https://esm.sh/react@18.3.1");
    expect(doc.querySelector('script[type="module"]').textContent).toContain("webide:src/main.js");
    expect(doc.querySelector('script[src]')).toBeNull();
  });

  it("reports missing HTML resources instead of publishing a broken snapshot", async () => {
    await expect(buildWebIdePreview(project({ "index.html": '<img src="missing.png">' }))).rejects.toThrow("Project resource not found: missing.png");
  });

  it("rejects unhandled local module types and nonportable resource URLs", async () => {
    await expect(buildWebIdePreview(project({ "src/main.js": 'import "./file.txt";', "src/file.txt": "text" }))).rejects.toThrow("Unsupported project module");
    await expect(buildWebIdePreview(project({ "index.html": '<img src="blob:https://example.com/local-id">' }))).rejects.toThrow("Resource URL cannot be shared");
  });

  it("accepts binary assets stored as data URLs and rejects raw binary strings", async () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const html = await buildWebIdePreview(project({ "assets/icon.png": data, "index.html": '<img src="assets/icon.png">' }));
    expect(new DOMParser().parseFromString(html, "text/html").querySelector("img").src).toBe(data);
    await expect(buildWebIdePreview(project({ "assets/icon.png": "raw bytes" }))).rejects.toThrow("must be stored as a data URL");
  });

  it("inlines style attributes, srcset, SVG hrefs and nested CSS imports", async () => {
    const html = await buildWebIdePreview(project({
      "index.html": '<style>@import "src/theme.css";</style><img srcset="assets/logo.svg 1x, assets/logo.svg 2x" style="background:url(assets/logo.svg)"><svg><use href="assets/logo.svg#mark" /></svg>',
      "src/theme.css": '@import "style.css";'
    }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("img").getAttribute("srcset")).toContain("data:image/svg+xml");
    expect(doc.querySelector("img").getAttribute("srcset")).not.toContain("assets/logo.svg");
    expect(doc.querySelector("img").getAttribute("style")).toContain("data:image/svg+xml");
    expect(doc.querySelector("use").getAttribute("href")).toMatch(/^data:image\/svg\+xml.*#mark$/);
    expect(doc.querySelector("style").textContent).toContain("data:text/css");
  });

  it("rejects circular CSS references and incompatible document import maps", async () => {
    await expect(buildWebIdePreview(project({ "src/style.css": '@import "style.css";' }))).rejects.toThrow("Circular resource reference");
    await expect(buildWebIdePreview(project({ "index.html": '<script type="importmap">{}</script>' }))).rejects.toThrow("managed by WebIDE");
  });
});
