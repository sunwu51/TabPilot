import { describe, expect, it, vi } from "vitest";
import { buildPackageImportMap, buildWebIdeModules, resolveWebIdeImport } from "./webIdeRuntime";

function decodeModule(dataUrl) {
  return decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1));
}

describe("webIdeRuntime", () => {
  it("maps exact package versions and package subpaths to esm.sh", () => {
    expect(buildPackageImportMap({ react: "18.3.1", "@scope/ui": "2.0.0" })).toEqual({
      react: "https://esm.sh/react@18.3.1",
      "react/": "https://esm.sh/react@18.3.1/",
      "@scope/ui": "https://esm.sh/@scope/ui@2.0.0",
      "@scope/ui/": "https://esm.sh/@scope/ui@2.0.0/"
    });
  });

  it("resolves extensionless project imports", () => {
    expect(resolveWebIdeImport("src/main.jsx", "./App", { "src/App.jsx": "" })).toBe("src/App.jsx");
  });

  it("builds native ESM modules for React, local files, and CSS", async () => {
    const transform = vi.fn(async ({ code }) => code);
    const result = await buildWebIdeModules({
      entry: "src/main.jsx",
      dependencies: { react: "18.3.1" },
      files: {
        "src/main.jsx": "import React from 'react'; import App from './App.jsx'; import './styles.css'; export { React, App };",
        "src/App.jsx": "export default function App() {}",
        "src/styles.css": "body { color: red; }"
      },
      transform
    });

    expect(result.entry).toBe("webide:src/main.jsx");
    expect(result.importMap.imports.react).toBe("https://esm.sh/react@18.3.1");
    const entrySource = decodeModule(result.importMap.imports["webide:src/main.jsx"]);
    expect(entrySource).toContain("'webide:src/App.jsx'");
    expect(entrySource).toContain("'webide:src/styles.css'");
    expect(decodeModule(result.importMap.imports["webide:src/styles.css"])).toContain("document.head.append(style)");
  });

  it("rejects npm imports that are missing from package.json", async () => {
    await expect(buildWebIdeModules({
      entry: "src/main.js",
      files: { "src/main.js": "import lodash from 'lodash'; export default lodash;" },
      transform: async ({ code }) => code
    })).rejects.toThrow("Dependency not declared in package.json: lodash");
  });

  it("rejects unresolved local imports", async () => {
    await expect(buildWebIdeModules({
      entry: "src/main.js",
      files: { "src/main.js": "import './missing.js';" },
      transform: async ({ code }) => code
    })).rejects.toThrow("Project file not found: ./missing.js imported by src/main.js");
  });
});
