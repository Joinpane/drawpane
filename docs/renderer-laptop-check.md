# Renderer check on a laptop

Use a test instance on the commit being checked, with a copy of the large iOS UI kit and the shadcn/ui kit. Use a Mac laptop with Safari and Chrome and a Windows laptop with integrated graphics with Edge and Chrome. Keep hardware acceleration on, plug in the laptop, and close other heavy apps. Use a fresh browser profile and leave software rendering disabled.

1. Open `/diagnostics/renderer` in each browser. Wait for Auto to finish, click **Copy report**, and save it. Run WebGL2 too if the page offers it.
2. Open each kit with `?renderer=engine`. Open the busiest page of each kit and the iOS kit's masked device screens. Record which renderer the editor shows. If it switches to Canvas, record the page and the reason from the renderer status.
3. Reopen the busiest page cold. Record when the first useful image appears and when it gets sharp. Pan around, pan into a part of the page you haven't visited, and zoom in and out several times. Look for stale glass, blurry text, blank tiles, or pauses after you stop.
4. On a busy board, drag a layer, drag a glass layer over other content, drag continuously through a busy area, resize a layer, nudge it with the arrows, and edit something under glass. Type in a layer with a missing font, then undo and redo. Record any case that freezes, fails to update, or shows old pixels.
5. Save your results in [the results page](renderer-laptop-results.md). Attach the diagnostic reports and any timings or recordings. Mark missing measurements as pending.

For Chrome and Edge, a checkout with dependencies installed can run the timed suite in the installed browser. Build once with `pnpm build`. Set the variables below in your shell, then run the command once with each converted kit folder.

| Variable | Value |
| --- | --- |
| `BENCH_BROWSER_CHANNEL` | `chrome` or `msedge` |
| `BENCH_RENDERER` | `engine` |
| `BENCH_ONLY` | `file` |
| `BENCH_FILE` | The local converted kit folder |
| `BENCH_OUT` | An absolute path for the JSON output, unique to this run |

```sh
pnpm --filter @drawpane/web bench -- bench/file.spec.ts bench/interactions.spec.ts
```

Use Safari itself for the Mac Safari row. The Playwright WebKit project is a different browser. Save a Safari Web Inspector Timelines recording if you can. Record a manual result and leave any unmeasured timings pending.

For WebGPU, the targets are p95 frame interval at most 16.7 ms, p99 at most 20 ms, and p95 engine and patch work at most 8 ms. Explain frames over 50 ms. The exact frame should arrive within 250 ms at p95 after movement or an in-budget edit. Cold open should show a useful image within 1 s and an exact image within 3 s. Compare WebGL2 against the previous run on the same device. See [decision 0040](decisions/0040-render-engine.md#interaction-gates-on-real-gpus) for the full gate.
