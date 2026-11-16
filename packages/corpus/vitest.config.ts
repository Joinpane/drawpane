import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fixed fast-check seeds unless FUZZ_SEED says otherwise; compact copies when asked.
    setupFiles: ["../../vitest.setup.ts", "./test/compact-setup.ts"],
  },
});
