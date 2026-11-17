# 0030. Kit parity: real files, measured against Figma frame by frame

- Status: accepted
- Date: 2026-11-16
- Deciders: Ziyang (lead maintainer)

## Context

The parity suites (decision 0013) hold small synthetic scenes to thresholds in CI: one shadow, one gradient, one line of text at a time. Real files fail in ways those scenes don't reach: auto layout nested ten deep, instances with overrides and swaps, icon libraries, text styles from variables, and the importer itself (decision 0025) between Figma's file and Drawpane's. A 500k-layer commercial UI kit imports whole now (decisions 0026 to 0028), but how close it looks to Figma was judged by eye.

Real files can't be committed: they're large, and most are licensed or private. So the measurement has to run by hand, on a file and a Figma account someone has, with its output kept out of the repo.

## Decision

1. **A harness, `tools/kit-parity`, that works on any `.fig` and its Figma file key.** It samples the file's frames deterministically (every page's top-level frames, component sets and components, and the frames built from the most instances), reads Figma's truth for each through the plugin API in a signed-in browser (Figma's own exporter at 2×, and the node tree with absolute boxes, render bounds and fonts), converts the `.fig` exactly as the dashboard's import does, draws each frame in a fresh local instance with the canvas renderer over the same page rect, and reads Drawpane's layout. The REST image API isn't used: it's rationed.
2. **Scores as the parity suites score.** Per frame, the mean difference over RGB and its 99th percentile (as `e2e/parity/pixels.ts`), both sides over white, and a heat map; per layer, matched by Figma id, moves relative to the parent and size changes past 0.5 px, text boxes, visibility and layers missing on either side. A run writes `scoreboard.json` and `report.html` (worst first, side by side). Two runs on the same code score the same, and a run can be checked against another (`--against`).
3. **Missing fonts stop a run.** A face Drawpane can't draw would swamp every other difference, so the Drawpane step fails loudly listing them.
4. **The Figma file is read, never written.** The session needs edit access (Figma runs no plugins in a file you can only view), so it guards against writing: keys go only to the focused quick actions box, every visited page is watched for changes made from the session, and shared plugin data is compared at the end.
5. **The spec is opt-in** (`E2E_KIT_PARITY`), like `E2E_LARGE_FIG`, and never runs in CI. Its output goes where the person running it says, outside the repo for files that aren't theirs to publish. The repo holds the harness and no file's content.
6. **Fixes come one root cause at a time,** each judged by a run against the baseline: the hill-climb this is for.

## Consequences

- The first baseline, on a 500k-layer commercial UI kit (406 sampled frames on 82 pages): median frame score 1.45, p90 10.16; 261 frames over 1, 160 over 2, 83 over 5, 41 over 10, 19 over 20. Two runs on the same code scored identically.
- Most of the difference is in the import, not the renderer. In order of cost: explicit variable modes not applied to copies (a dark section draws light), copies losing the sizes Figma saved for them (nested icons stretched on one axis, overridden text keeping its main's width), drop shadows drawn behind transparent fills (focus rings fill their fields), text placed half a point off, slot layers placed without their instance's padding and given ids of their own, and image fills scaled differently. Each gets its own fix, judged by a run against this baseline.
- On this VM a cold run takes about 70 minutes: about 12 to convert the kit (cached by the file and the converter's source), about 50 for Figma's side (resumable, once per sample), and about 6 for drawing, laying out and scoring. A fix is judged in about 6 minutes, plus 12 when it changes the converter.
- The editor gains a debug-only handle (`drawpaneParity`) for fonts, layout and exact-rect renders. `tools/kit-parity` is a workspace package so its TypeScript is typechecked; the CLI runs it through Vite's module runner.
