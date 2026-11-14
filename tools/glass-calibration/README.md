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
