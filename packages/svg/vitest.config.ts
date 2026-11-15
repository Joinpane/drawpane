import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DOMParser and element.matches for the converter, as in the browser.
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../../vitest.setup.ts"],
  },
});
