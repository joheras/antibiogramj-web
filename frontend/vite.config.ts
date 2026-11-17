import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite --mode browser` builds the version that runs entirely in the user's browser
// (OpenCV.js + IndexedDB, see src/browser/); the default mode uses the FastAPI backend.
export default defineConfig(({ mode }) => {
  const browser = mode === "browser";
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "virtual:api-impl": fileURLToPath(new URL(browser ? "./src/browser/localApi.ts" : "./src/http.ts", import.meta.url)),
        // Google Drive, phone capture and inbox exist only in the browser build.
        "virtual:browser-ui": fileURLToPath(new URL(browser ? "./src/browser/ui.ts" : "./src/browser/ui.server.ts", import.meta.url)),
      },
    },
    base: browser ? "./" : "/", // the browser build can be hosted under any path
    publicDir: browser ? "public-browser" : false,
    worker: { format: "es" },
    build: {
      outDir: browser ? "dist-browser" : "dist",
      chunkSizeWarningLimit: browser ? 12000 : 500,
    },
    server: {
      port: 5173,
      proxy: browser ? undefined : { "/api": "http://127.0.0.1:8000" },
    },
  };
});
