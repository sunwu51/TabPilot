import { build } from "esbuild";
import { access, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const entryPoint = fileURLToPath(new URL("../src/vendor/nanollm-converter-entry.js", import.meta.url));
const outputFile = fileURLToPath(new URL("../src/vendor/nanollm-protocol-converter.js", import.meta.url));
const publicOutputFile = fileURLToPath(new URL("../public/vendor/nanollm-protocol-converter.js", import.meta.url));
const contextShim = fileURLToPath(new URL("../src/vendor/nanollm-request-context-browser.js", import.meta.url));
const generatedSource = fileURLToPath(new URL("../nanollm/src/converters/index.ts", import.meta.url));

// The generated converter is committed so CI does not need the sibling nanollm
// checkout. Set NANOLLM_REFRESH=1 when refreshing it from local source.
if (process.env.NANOLLM_REFRESH !== "1") {
  try {
    await access(outputFile);
    await access(publicOutputFile);
    console.log("Using committed nanollm converter artifacts");
    process.exit(0);
  } catch {
    // Fall through and produce the artifacts when they are missing.
  }
}

try {
  await access(generatedSource);
} catch {
  throw new Error(
    `nanollm source is unavailable at ${generatedSource}. ` +
    "Use the committed converter artifacts or set up the sibling nanollm checkout."
  );
}

await build({
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [{
    name: "nanollm-browser-request-context",
    setup(buildContext) {
      buildContext.onResolve({ filter: /request-context\.js$/ }, () => ({ path: contextShim }));
    }
  }],
  banner: {
    js: "/* Generated from ../nanollm/src/converters. Run npm run build:nanollm-converter to refresh. */"
  }
});

await copyFile(outputFile, publicOutputFile);

console.log(`Built ${outputFile} and ${publicOutputFile}`);
