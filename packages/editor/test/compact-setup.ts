/**
 * DRAWPANE_COMPACT_COPIES=1 runs the suite with compact copies (decision
 * 0029) on for every document, as `pnpm test` does on its second pass.
 */
import { setCompactCopiesDefault } from "../src/doc";

if (process.env.DRAWPANE_COMPACT_COPIES === "1") setCompactCopiesDefault(true);
