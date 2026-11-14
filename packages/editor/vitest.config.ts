import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fixed fast-check seeds unless FUZZ_SEED says otherwise.
    setupFiles: ["../../vitest.setup.ts"],
  },
});
