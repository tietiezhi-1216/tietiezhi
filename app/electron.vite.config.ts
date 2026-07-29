import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";

/**
 * The renderer is the existing `desktop/` frontend, reused as-is. Electron does
 * not get its own copy: the preload injects `window.__TAURI_INTERNALS__`, so
 * `@tauri-apps/api` keeps working and no frontend source needs to change.
 */
const desktopRoot = resolve(__dirname, "../desktop");

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
      rollupOptions: {
        // Keep the ACP SDK external so the agent subprocess protocol code is
        // loaded from node_modules at runtime rather than inlined.
        external: ["electron", "@agentclientprotocol/sdk"],
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
      rollupOptions: { external: ["electron"] },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
  },
  renderer: {
    root: desktopRoot,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(desktopRoot, "src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(desktopRoot, "index.html"),
          capsule: resolve(desktopRoot, "capsule.html"),
        },
      },
    },
  },
});
