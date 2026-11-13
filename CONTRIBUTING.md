# Contributing to Drawpane

Thanks for helping. This file covers how to run the project, how the code is laid out, and what a pull request needs.

## Run it locally

```sh
mise install          # Node 26 and pnpm 12 (or install them yourself)
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
| `packages/ui` | The design system in React: tokens (generated from `design-system/tokens.json`), components, icons. |
| `apps/worker` | The Cloudflare Worker: auth, REST API, static assets and the FileRoom Durable Object. |
| `apps/web` | The browser app: sign-in, dashboard and the editor shell. |
| `design-system/`, `designs/` | The visual and behavioral spec. |
| `docs/` | The PRD, decisions (`docs/decisions`), and guides. |

## Checks

```sh
pnpm check    # Biome lint, TypeScript, all tests
pnpm build
```

CI runs the same on every pull request.

## Pull requests

- Keep them focused, and write the description for a reviewer who hasn't seen the code.
- Changes to the file format, the public API or the design system need a short RFC in `docs/rfcs/` first.
- UI changes include a before/after recording and use design tokens only: no raw colors, no off-scale spacing.
- Sign off your commits (`git commit -s`), certifying the [Developer Certificate of Origin](https://developercertificate.org/).
- All code is MPL-2.0.
