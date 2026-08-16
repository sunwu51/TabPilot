import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.js"],
  },
  build: {
    modulePreload: false,
    rollupOptions: {
      input: {
        service_worker: "src/service_worker.js",
        content: "src/content.js",
        sidepanel: "sidepanel.html",
        playground: "playground.html",
        playgroundHost: "playground-host.html",
        webide: "webide.html",
        webideHost: "webide-host.html",
        stash: "stash.html",
        postdog: "postdog.html",
        imageViewer: "image-viewer.html",
      },
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
        chunkFileNames: "[name].js",
      },
    },
    outDir: "dist"
  }
});
