import { init, parse } from "es-module-lexer";

const CODE_LANGUAGES = Object.freeze({
  js: "js",
  jsx: "jsx",
  ts: "ts",
  tsx: "tsx"
});

export function normalizeWebIdePath(path) {
  const parts = [];
  for (const part of String(path || "").replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function resolveWebIdeImport(importer, specifier, files) {
  const importerPath = normalizeWebIdePath(importer);
  const slash = importerPath.lastIndexOf("/");
  const base = specifier.startsWith("/") ? "" : slash < 0 ? "" : importerPath.slice(0, slash);
  const candidate = normalizeWebIdePath(`${base}/${specifier}`);
  const choices = [
    candidate,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.css`,
    `${candidate}.json`,
    `${candidate}/index.js`,
    `${candidate}/index.jsx`,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`
  ];
  const resolved = choices.find(path => Object.prototype.hasOwnProperty.call(files, path));
  if (!resolved) throw new Error(`Project file not found: ${specifier} imported by ${importer}`);
  return resolved;
}

export function buildPackageImportMap(dependencies = {}) {
  const imports = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (!name || !version) continue;
    const target = `https://esm.sh/${name}@${version}`;
    imports[name] = target;
    imports[`${name}/`] = `${target}/`;
  }
  return imports;
}

export async function buildWebIdeModules({ files, entry, dependencies = {}, transform = transformWithEsmSh }) {
  await init;
  const packageImports = buildPackageImportMap(dependencies);
  const moduleSources = {};

  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const normalizedPath = normalizeWebIdePath(path);
    const extension = normalizedPath.split(".").pop()?.toLowerCase();
    let javascript;
    if (CODE_LANGUAGES[extension]) {
      javascript = await transform({ path: normalizedPath, code: String(source), lang: CODE_LANGUAGES[extension] });
    } else if (extension === "css") {
      javascript = cssModuleSource(normalizedPath, String(source));
    } else if (extension === "json") {
      javascript = jsonModuleSource(normalizedPath, String(source));
    } else {
      return;
    }
    moduleSources[normalizedPath] = await rewriteModuleImports(javascript, normalizedPath, files, dependencies);
  }));

  const normalizedEntry = normalizeWebIdePath(entry);
  if (!Object.prototype.hasOwnProperty.call(moduleSources, normalizedEntry)) {
    throw new Error(`Project entry is not a JavaScript module: ${entry}`);
  }

  const imports = { ...packageImports };
  for (const [path, source] of Object.entries(moduleSources)) {
    imports[moduleSpecifier(path)] = javascriptDataUrl(source);
  }
  return { importMap: { imports }, entry: moduleSpecifier(normalizedEntry) };
}

export async function transformWithEsmSh({ path, code, lang }) {
  const response = await fetch("https://esm.sh/transform", {
    method: "POST",
    body: JSON.stringify({ filename: path, code, lang, target: "es2022", minify: false })
  });
  if (!response.ok) throw new Error(`esm.sh transform failed (${response.status}) for ${path}`);
  const result = await response.json();
  if (result?.error) throw new Error(`esm.sh transform failed for ${path}: ${result.error.message || result.error}`);
  if (typeof result?.code !== "string") throw new Error(`esm.sh transform returned no code for ${path}`);
  return result.code;
}

async function rewriteModuleImports(source, importer, files, dependencies) {
  const [imports] = parse(source);
  const replacements = [];
  for (const item of imports) {
    if (typeof item.n !== "string") continue;
    const specifier = item.n;
    let replacement = specifier;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      replacement = moduleSpecifier(resolveWebIdeImport(importer, specifier, files));
    } else if (!isUrlSpecifier(specifier)) {
      const packageName = getPackageName(specifier);
      if (!Object.prototype.hasOwnProperty.call(dependencies, packageName)) {
        throw new Error(`Dependency not declared in package.json: ${packageName} imported by ${importer}`);
      }
    }
    if (replacement !== specifier) replacements.push({ start: item.s, end: item.e, value: replacement });
  }
  return replacements.sort((a, b) => b.start - a.start)
    .reduce((code, item) => `${code.slice(0, item.start)}${item.value}${code.slice(item.end)}`, source);
}

function moduleSpecifier(path) {
  return `webide:${normalizeWebIdePath(path)}`;
}

function getPackageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isUrlSpecifier(specifier) {
  return /^(?:https?:|data:|blob:)/.test(specifier);
}

function cssModuleSource(path, css) {
  return `const css = ${JSON.stringify(css)};\nconst style = document.createElement("style");\nstyle.dataset.webidePath = ${JSON.stringify(path)};\nstyle.textContent = css;\ndocument.head.append(style);\nexport default css;`;
}

function jsonModuleSource(path, json) {
  try {
    return `export default ${JSON.stringify(JSON.parse(json))};`;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}

function javascriptDataUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}
