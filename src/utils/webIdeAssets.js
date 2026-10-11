import { normalizeWebIdePath } from "./webIdePaths";

const ASSET_TYPES = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf"
};

export function isWebIdeAsset(path) {
  return Object.hasOwn(ASSET_TYPES, path.split(".").pop().toLowerCase());
}

function isExternal(url) {
  if (/^(?:blob:|file:|chrome-extension:)/i.test(url)) throw new Error(`Resource URL cannot be shared: ${url}`);
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);
}

function resolveResource(url, importer, files) {
  const pathname = decodeURIComponent(url.split(/[?#]/)[0]);
  const directory = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/") + 1) : "";
  const path = normalizeWebIdePath(pathname.startsWith("/") ? pathname : directory + pathname);
  if (!Object.hasOwn(files, path)) throw new Error(`Project resource not found: ${url} referenced by ${importer}`);
  return path;
}

export function webIdeAssetDataUrl(path, source) {
  const content = String(source);
  if (/^data:[^,]+,/i.test(content.trim())) return content.trim();
  if (/\.svg$/i.test(path)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
  throw new Error(`Binary resource ${path} must be stored as a data URL in the text VFS`);
}

export function inlineWebIdeResource(url, importer, files, stack = []) {
  if (!url || isExternal(url)) return url;
  const path = resolveResource(url, importer, files);
  if (stack.includes(path)) throw new Error(`Circular resource reference: ${path}`);
  const fragment = url.includes("#") ? url.slice(url.indexOf("#")) : "";
  if (/\.css$/i.test(path)) {
    return `data:text/css;charset=utf-8,${encodeURIComponent(inlineWebIdeCss(files[path], path, files, [...stack, path]))}${fragment}`;
  }
  if (!isWebIdeAsset(path)) throw new Error(`Unsupported project resource: ${path}`);
  return webIdeAssetDataUrl(path, files[path]) + fragment;
}

export function inlineWebIdeCss(css, importer, files, stack = []) {
  // Keep comments unchanged. Handle both url(...) and quoted @import sources.
  return String(css).replace(/\/\*[\s\S]*?\*\/|url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]+)"|'([^']+)')/gi,
    (match, double, single, bare, importDouble, importSingle) => {
      if (match.startsWith("/*")) return match;
      const url = double ?? single ?? bare ?? importDouble ?? importSingle;
      const result = inlineWebIdeResource(url, importer, files, stack);
      if (result === url) return match;
      return match.toLowerCase().startsWith("@import") ? `@import url("${result}")` : `url("${result}")`;
    });
}

export function inlineWebIdeHtml(html, files) {
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  if (doc.querySelector("base")) throw new Error("Project base elements are unsupported in portable previews");
  for (const node of doc.querySelectorAll("style")) node.textContent = inlineWebIdeCss(node.textContent, "index.html", files);
  for (const node of doc.querySelectorAll("[style]")) node.setAttribute("style", inlineWebIdeCss(node.getAttribute("style"), "index.html", files));
  for (const node of doc.querySelectorAll("img[src], input[type=image][src], source[src], video[src], audio[src], video[poster], link[href]")) {
    const attributes = node.tagName === "LINK" ? ["href"] : ["src", "poster"];
    for (const attribute of attributes) {
      if (!node.hasAttribute(attribute)) continue;
      node.setAttribute(attribute, inlineWebIdeResource(node.getAttribute(attribute), "index.html", files));
    }
  }
  for (const node of doc.querySelectorAll("img[srcset], source[srcset]")) {
    const value = node.getAttribute("srcset");
    node.setAttribute("srcset", value.replace(/(data:[^\s]+|[^\s,]+)(\s+[\d.]+[wx])?(\s*,\s*|$)/g,
      (_match, url, descriptor = "", separator) => inlineWebIdeResource(url, "index.html", files) + descriptor + separator));
  }
  for (const node of doc.querySelectorAll("script[src]")) {
    const src = node.getAttribute("src");
    if (!isExternal(src)) {
      const path = resolveResource(src, "index.html", files);
      if (node.getAttribute("type") !== "module") throw new Error(`Local script ${src} must use type="module"`);
      node.removeAttribute("src");
      node.textContent = `import ${JSON.stringify(`webide:${path}`)};`;
    }
  }
  for (const node of doc.querySelectorAll("use[href], use[xlink\\:href], image[href], image[xlink\\:href]")) {
    for (const attribute of ["href", "xlink:href"]) {
      if (node.hasAttribute(attribute)) node.setAttribute(attribute, inlineWebIdeResource(node.getAttribute(attribute), "index.html", files));
    }
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
