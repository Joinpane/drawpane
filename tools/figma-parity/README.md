# Render parity with Figma

How close Drawpane draws to Figma, measured cell by cell and kept from drifting. Each suite in `scenes/` is a grid of small scenes (one card, one effect or paint varied at a time), written once in Drawpane's own properties. Figma draws them from the same file; its renders, at 2×, are the goldens. The e2e suite `apps/web/e2e/parity` draws each cell in Drawpane and compares:

- **Score:** the mean difference over RGB, 0–255, and its 99th percentile, which shows local defects a mean hides.
- **Gate:** each cell's score must stay within `thresholds.json`. A change that draws further from Figma fails CI; one that draws closer is locked in by recording thresholds again (`UPDATE_THRESHOLDS=1`).
- **Report:** `apps/web/test-results/parity/index.html` shows Figma, Drawpane and a heat map of the difference for every cell.

Suites with random grain (noise, texture) compare after blurring both sides (`"blur"` in the scene file), so they measure density and tone, not where each grain falls.

## Running it

```sh
pnpm build
cd apps/web
E2E_PORT=8943 npx playwright test e2e/parity            # check against the thresholds
E2E_PORT=8943 UPDATE_THRESHOLDS=1 npx playwright test e2e/parity   # record new ones
```

## Changing scenes

1. Edit or add `scenes/<suite>.json`. Layers use Drawpane's properties (`packages/model/src/schema.ts`); `figma-builder.js` is the one place they become Figma's.
2. Build the scenes in a Figma file you can edit. In Figma in a browser, signed in with an email and password:

   ```sh
   FIGMA_EMAIL=… FIGMA_PASSWORD=… node tools/figma-parity/build-in-figma.mjs <file link> [suite…]
   ```

   Figma's web app can't import development plugins, but once any plugin has run in a session it exposes its plugin API to the page; the script runs one, then calls `figma-builder.js` there. Each suite gets a page "Parity: &lt;suite&gt;" of frames named "&lt;suite&gt;/&lt;id&gt;", replacing the old one. The session is kept in `FIGMA_PROFILE` (default `/tmp/figma-parity-profile`).

3. Export Figma's renders into `goldens/`, with Figma's own exporter in the same kind of session:

   ```sh
   FIGMA_EMAIL=… FIGMA_PASSWORD=… node tools/figma-parity/export-in-figma.mjs <file link> [suite…]
   ```

   Or fetch them through the REST API with a token that can read file content (`FIGMA_TOKEN=… node tools/figma-parity/fetch-goldens.mjs <file link> [suite…]`). The two give the same renders, but REST image reads are rationed: a file on Figma's free plan runs out after a few and then waits days. Both scripts share the browser session code in `figma-session.mjs`.

4. Run the suite with `UPDATE_THRESHOLDS=1`, look at the report, and commit the scenes, goldens and thresholds together.

The glass effect has its own fitting harness, `tools/glass-calibration`, which searches the shader's constants against the same kind of renders.
