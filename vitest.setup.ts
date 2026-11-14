/**
 * Property tests across the workspace run a fixed seed by default, so a push
 * never fails on a rare case found by chance in someone else's change. To
 * hunt instead, set FUZZ_SEED=random (and FUZZ_RUNS for more runs): `pnpm
 * fuzz` and the nightly Fuzz workflow do. A failure prints its seed; replay it
 * with FUZZ_SEED=<seed>.
 */
import fc from "fast-check";

const seed = process.env.FUZZ_SEED;
const runs = Number(process.env.FUZZ_RUNS);
fc.configureGlobal({
  ...(seed === "random" ? {} : { seed: seed ? Number(seed) : 20261114 }),
  ...(runs > 0 ? { numRuns: runs } : {}),
});
