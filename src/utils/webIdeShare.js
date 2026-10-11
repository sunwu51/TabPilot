import { buildWebIdeModules } from "./webIdeRuntime";
import { inlineWebIdeHtml } from "./webIdeAssets";
import { deflateStringToQueryParam } from "./playgroundCodec";

export const PUBLIC_WEB_IDE_PREVIEW_URL = "https://sunwu51.github.io/HtmlPlayground/";

export async function buildWebIdePreview({ files, entry, transform }) {
  let packageJson;
  try {
    packageJson = JSON.parse(files["package.json"] || "{}");
  } catch (error) {
    throw new Error(`Invalid package.json: ${error.message}`);
  }
  const result = await buildWebIdeModules({ files, entry, dependencies: packageJson?.dependencies || {}, transform });
  const html = inlineWebIdeHtml(files["index.html"] || '<html><body><div id="app"></div></body></html>', files);
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc.querySelector('script[type="importmap"]')) throw new Error("Project import maps are managed by WebIDE; declare dependencies in package.json");
  const map = doc.createElement("script");
  map.type = "importmap";
  map.textContent = JSON.stringify(result.importMap).replace(/</g, "\\u003c");
  // The import map must precede every module, including scripts from index.html.
  doc.head.prepend(map);
  const main = doc.createElement("script");
  main.type = "module";
  main.textContent = `import ${JSON.stringify(result.entry)};`;
  doc.body.append(main);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

export function buildWebIdeShareUrl(previewHtml) {
  // HtmlPlayground places the html field inside its own document. A nested srcdoc
  // preserves the project's document/head/import-map order without changing the public app.
  const escapeAttribute = text => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<iframe title="Shared WebIDE project" sandbox="allow-scripts allow-forms allow-modals allow-popups" style="position:fixed;inset:0;width:100%;height:100%;border:0" srcdoc="${escapeAttribute(previewHtml)}"></iframe>`;
  const url = new URL(PUBLIC_WEB_IDE_PREVIEW_URL);
  url.hash = new URLSearchParams({
    html: deflateStringToQueryParam(html),
    css: deflateStringToQueryParam("html,body{margin:0;height:100%;overflow:hidden}"),
    js: deflateStringToQueryParam(""),
    expanded: "0"
  }).toString();
  return url.toString();
}
