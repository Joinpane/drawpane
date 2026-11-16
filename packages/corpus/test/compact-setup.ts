/**
 * DRAWPANE_COMPACT_COPIES=1 runs the suite with compact copies (decision
 * 0029) on for every editor document, as `pnpm test` does on its second pass.
 */
import { setCompactCopiesDefault } from "@drawpane/editor";

if (process.env.DRAWPANE_COMPACT_COPIES === "1") setCompactCopiesDefault(true);
