# Glass calibration

Calibrates Drawpane's glass effect (decision 0007) against Figma's. Both draw the same cells, described once in `scenes.json`: the same vector backdrop and one glass shape, varying one setting at a time around Figma's defaults. Text is left out of the backdrop because the two render fonts differently. Then:

1. Figma renders its cells through its REST API.
2. Drawpane renders the same cells.
3. A harness compares them, scoring each cell on the glass shape and its rim, and fits the glass shader's constants to Figma's look. Held-out cells check that the fit generalises.

## Making the cells in Figma (once)

In the Figma desktop app:

1. Open a new design file.
2. Choose **Plugins → Development → Import plugin from manifest…**, and pick `tools/glass-calibration/figma-plugin/manifest.json`.
3. Run **Plugins → Development → Drawpane glass calibration**. It adds a **Glass calibration** page of cells named `glass-<id>`.

In Figma in a browser, which can't import development plugins: open the file, run any plugin once (Figma then exposes its plugin API to the page as `figma`), and run `figma-plugin/code.js` in the page, with `figma.closePlugin` swapped for a function that reports the message. In a browser driven by Playwright that's one `page.evaluate`.

Then share the file's link, and a personal access token that can read file content (Figma → Settings → Security → Personal access tokens, scope *File content: read*).

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

## Results

The first fit against Figma (November 2026) took the mean difference from 10.3 to 3.2 (of 255, over the glass and its rim). It showed that a rim deeper than the shape's inner radius flipped its bend where rims from opposite sides meet; capping the rim there, and fitting again, brought it to 2.7. Most cells now differ by about 2. The largest gap left is a rim much deeper than the shape (`depth-80`, 11): Figma bends the backdrop into smooth curves there, while ours still folds a little at the corners.

Without `TARGET_DIR`, the harness tests itself: it renders the cells at a known tuning and fits back to it from the defaults. The first run took the error from 2.29 to 0.28 and recovered the constants that matter visibly (bend 0.72 against 0.70, profile 2.1 against 2.0, highlight 1.56 against 1.6).

