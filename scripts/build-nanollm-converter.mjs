import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const entryPoint = fileURLToPath(new URL("../src/vendor/nanollm-converter-entry.js", import.meta.url));
const outputFile = fileURLToPath(new URL("../src/vendor/nanollm-protocol-converter.js", import.meta.url));
const publicOutputFile = fileURLToPath(new URL("../public/vendor/nanollm-protocol-converter.js", import.meta.url));
const contextShim = fileURLToPath(new URL("../src/vendor/nanollm-request-context-browser.js", import.meta.url));

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
