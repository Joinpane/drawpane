import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serves the local component gallery (gallery/index.html). The package itself ships as source.
export default defineConfig({
  root: fileURLToPath(new URL("./gallery", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/gallery", import.meta.url)),
    emptyOutDir: true,
  },
});
