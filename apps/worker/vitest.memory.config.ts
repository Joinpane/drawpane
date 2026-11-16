import { defineConfig } from "vitest/config";

/**
 * The memory check (test-node/memory.test.ts): the room's code paths in
 * Node, against node:sqlite and a file-backed R2, with the V8 heap capped
 * at a Durable Object's 128 MB (or MEMORY_HEAP_MB, to find how little each
 * path gets by on). Not part of `pnpm test` (it takes minutes);
 * run it with `pnpm --filter @drawpane/worker memory`.
 */
export default defineConfig({
  test: {
    include: ["test-node/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    execArgv: ["--expose-gc", `--max-old-space-size=${process.env.MEMORY_HEAP_MB ?? 128}`],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
