# Glass calibration

Calibrates Drawpane's glass effect (decision 0007) against Figma's. Both draw the same cells, described once in `scenes.json`: the same vector backdrop and one glass shape, varying one setting at a time around Figma's defaults. Text is left out of the backdrop because the two render fonts differently. Then:

1. Figma renders its cells through its REST API.
2. Drawpane renders the same cells.
3. A harness compares them, scoring each cell on the glass shape and its rim, and fits the glass shader's constants to Figma's look. Held-out cells check that the fit generalises.

## Making the cells in Figma (once)

1. In the Figma desktop app, open a new design file.
2. Choose **Plugins → Development → Import plugin from manifest…**, and pick `tools/glass-calibration/figma-plugin/manifest.json`.
3. Run **Plugins → Development → Drawpane glass calibration**. It adds a **Glass calibration** page of cells named `glass-<id>`.
4. Share the file's link, and a personal access token that can read file content (Figma → Settings → Security → Personal access tokens, scope *File content: read*).

After changing `scenes.json`, run `node tools/glass-calibration/build-plugin.mjs` to rebuild `figma-plugin/code.js`. Then delete the old page in Figma and run the plugin again.

## Fitting

1. Fetch Figma's renders, with the token from the vault or your own:

   ```sh
   FIGMA_TOKEN=… node tools/glass-calibration/fetch-figma.mjs <file link> /tmp/glass-figma
   ```

2. Build, then fit. It takes about 12 minutes for 6 rounds:

   ```sh
   pnpm build
   TARGET_DIR=/tmp/glass-figma OUT_DIR=/tmp/glass-fit \
     pnpm --filter @drawpane/web exec playwright test --project=calibration
   ```

   The harness draws every cell at 2× in one view, with the constants (`GlassTuning` in `packages/editor/src/glass.ts`) set through the debug hook. It scores each cell over the glass and its rim (mean difference, 0–255), and searches the constants by coordinate descent. It writes `tuning.json` and `compare.html`, the targets beside the fitted renders.

3. Put the fitted values in `DEFAULT_GLASS_TUNING`, and check the result by eye.

Without `TARGET_DIR`, the harness tests itself: it renders the cells at a known tuning and fits back to it from the defaults. The first run took the error from 2.29 to 0.28 and recovered the constants that matter visibly (bend 0.72 against 0.70, profile 2.1 against 2.0, highlight 1.56 against 1.6).

