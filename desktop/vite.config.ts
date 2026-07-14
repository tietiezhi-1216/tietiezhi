import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import browserslistToEsbuild from "browserslist-to-esbuild";

// Tauri dev expects a fixed port; build targets follow browserslist in
// package.json (WebView2 = evergreen Chromium, WKWebView = Safari 16.4+).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: browserslistToEsbuild(),
  },
});
