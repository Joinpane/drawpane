# Contributing to Drawpane

Thanks for helping. This file covers how to run the project, how the code is laid out, and what a pull request needs.

## Run it locally

```sh
mise install          # Node 26 and pnpm 12 (or install them yourself)
(cd packages/engine && mise install)   # Rust for the render engine (decision 0040)
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @drawpane/worker run db:migrate:local
pnpm dev              # Worker on :8787, the app on :5173
```

Open http://localhost:5173. A fresh local database sends you to setup; the token is `dev-setup-token` from `.dev.vars`. Passkeys work on `localhost`.

## Layout

| Path | What it is |
| --- | --- |
| `packages/model` | The document model: nodes, typed operations, validation and apply. Pure TypeScript, runs everywhere. |
| `packages/editor` | The editor engine: sync client, history, geometry, auto layout, renderer, interaction. No React. |
| `packages/engine` | The render engine (decision 0040): Rust built to WebAssembly, drawn by Vello on WebGPU and on the CPU, behind `?renderer=engine`. |
| `packages/ui` | The design system in React: tokens (generated from `design-system/tokens.json`), components, icons. |
| `apps/worker` | The Cloudflare Worker: auth, REST API, static assets and the FileRoom Durable Object. |
| `apps/web` | The browser app: sign-in, dashboard and the editor shell. |
| `design-system/`, `designs/` | The visual and behavioral spec. |
| `docs/` | The PRD, decisions (`docs/decisions`), and guides. |

## Checks

```sh
pnpm check    # Biome lint, TypeScript, all tests
pnpm build
pnpm --filter create-drawpane smoke   # the installer's release deploys (Wrangler dry run)
pnpm --filter @drawpane/web e2e       # the browser suite, after a build (Playwright, Chromium)
```

The browser suite starts its own Workers with throwaway databases, each spec file on its own ports, so nothing else needs to be running. One file: `pnpm --filter @drawpane/web e2e e2e/layers.spec.ts`. A failure keeps a trace in `apps/web/test-results`: open it with `npx playwright show-trace`.

CI runs the same on every pull request, the browser suite split four ways. Releases are cut by pushing a version tag: see [RELEASING.md](RELEASING.md).

## Pull requests

- Keep them focused, and write the description for a reviewer who hasn't seen the code.
- Changes to the file format, the public API or the design system need a short RFC in `docs/rfcs/` first.
- UI changes include a before/after recording and use design tokens only: no raw colors, no off-scale spacing.
- Sign off your commits (`git commit -s`), certifying the [Developer Certificate of Origin](https://developercertificate.org/).
- All code is MPL-2.0.
