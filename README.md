# Drawpane

The open design tool you own. Drawpane is a real-time design and prototyping tool that anyone can deploy to their own Cloudflare account in minutes, and that runs for cents when idle. AI agents join a file as collaborators, working on their own branch.

**Status:** pre-alpha. The maintainers design Drawpane in Drawpane, on a self-hosted instance that every merged change deploys to.

## What works today

- Passkey accounts, teams, invites, projects, files and trash
- A real-time multiplayer editor: frames, rectangles, ellipses, polygons, stars, lines and arrows, text, images and vector paths; move with smart guides, resize, rotate, group, frame, mask, crop images, reorder; auto layout that maps 1:1 to CSS flexbox; constraints; fills, strokes, shadows and blur; pages and a layers tree
- A full color picker (solid, linear, radial and angular gradients, image, eyedropper, contrast ratio), stroke end markers, per-corner radius, frame presets for current phones, tablets and desktops, align, distribute, tidy up and flip
- Rulers (`⇧R`), guides you drag out of them onto the page or a board, and layout grids (columns, rows, square) that layers snap to
- Right-click menus on the canvas, layers and pages; copy and paste properties; a keyboard shortcuts sheet (`⌘/`)
- The pen tool, vector editing, flatten and boolean operations
- Components with instances and overrides, and variants with properties you can swap
- Design tokens as variables, with modes, aliases and DTCG import and export
- Prototyping: interactions on any layer (tap, hover, drag, key, delay), navigate, overlays, back and links, transitions with eases, béziers and springs, flows and devices
- Present mode, and prototype links that anyone can open without an account, turned off or reset at any time
- Inspect with CSS, Tailwind and JSX; image export; comments with threads, mentions, live updates and pins you can drag
- The command bar (`⌘K`) that runs actions, jumps to layers, and sets values with a short syntax: `w 320`, `gap 16`, `fill #ff5a1f`, `p 8 16`
- The Selection Lens, Layout X-ray (hold `Alt`), focus mode, and collaborators' cursors and selections
- Undo and redo for your own changes, and edits that survive a dropped connection
- Version history: automatic and named versions, a timeline to scrub through them, and restoring a single layer or the whole file, which anyone can undo

See the [PRD](docs/PRD.md) for where it's going.

## How it's built

| Where | What |
| --- | --- |
| [`packages/model`](packages/model) | The document model: a flat map of nodes, typed operations, validation. Shared by the browser, the server and agents. |
| [`packages/editor`](packages/editor) | The editor engine: sync client, undo, geometry, auto layout, Canvas renderer, interaction. Framework-free. |
| [`packages/ui`](packages/ui) | The design system as React components, with tokens generated from [`design-system/tokens.json`](design-system/tokens.json). |
| [`packages/penpot`](packages/penpot) | Reads Penpot's `.penpot` exports and converts them to Drawpane files. |
| [`packages/create-drawpane`](packages/create-drawpane) | `npm create drawpane`: installs and upgrades an instance on your Cloudflare account. |
| [`apps/worker`](apps/worker) | The Cloudflare Worker: passkey auth, REST API, static assets, and a FileRoom Durable Object per file (SQLite, one row per node). |
| [`apps/web`](apps/web) | The browser app: sign-in, dashboard and the editor. |
| [`docs/`](docs) | [PRD](docs/PRD.md), [decisions](docs/decisions), [self-hosting guide](docs/self-hosting.md). |
| [`design-system/`](design-system/README.md), [`designs/`](designs/README.md) | The brand book and 156 product artboards: the visual and behavioral spec. |

Why TypeScript from scratch rather than a Penpot fork: [decision 0001](docs/decisions/0001-build-from-scratch-in-typescript.md).

## Develop

```sh
mise install && pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @drawpane/worker run db:migrate:local
pnpm dev
```

Then open http://localhost:5173. More in [CONTRIBUTING.md](CONTRIBUTING.md).

## Self-host

```sh
npm create drawpane my-design
```

It signs you in to Cloudflare, creates what the instance needs on your account, deploys it, and opens the page where you create the first account. Upgrading is `npm create drawpane@latest upgrade` in that folder. Until the installer is published to npm, run it from a clone: `pnpm install && pnpm build && node packages/create-drawpane/dist/cli.js my-design`. Details, and the steps done by hand: [docs/self-hosting.md](docs/self-hosting.md).

## Viewing the designs

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000/designs/ and http://localhost:8000/design-system/.

## License

[MPL-2.0](LICENSE). Drawpane was inspired by [Penpot](https://penpot.app) and is not affiliated with it.
