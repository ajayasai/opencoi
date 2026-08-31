import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/tesseract.js/dist/worker.min.js",
          dest: "tesseract",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/tesseract.js-core/tesseract-core*.wasm.js",
          dest: "tesseract/core",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/tesseract.js-core/tesseract-core*.wasm",
          dest: "tesseract/core",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
          dest: "tesseract/lang",
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./client", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4174",
      "/uploads": "http://127.0.0.1:4174",
    },
  },
});
