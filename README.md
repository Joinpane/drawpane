# Drawpane

Next-gen open-source design platform for agents and teams: an open design and prototyping tool, forked from Penpot, that anyone can deploy to their own Cloudflare account and that runs for cents when idle. AI agents join a file as collaborators, working on their own branch.

This repository starts with the complete product definition. Everything needed to build Drawpane is here, so nothing has to be looked up elsewhere.

| Where | What |
| --- | --- |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements: vision, personas, goals and metrics, positioning, signature UX, AI agents, functional and non-functional requirements, Cloudflare architecture, upstream strategy, cost model, repo layout and governance, roadmap, risks and decisions |
| [`docs/diagrams/`](docs/diagrams) | The PRD's diagrams (agent flow, architecture, roadmap) as SVG |
| [`design-system/`](design-system/README.md) | The Drawpane design system: brand book, tokens (`tokens.json`, `tokens.css`), 20 React components (`components/bundle.js`, typed in `index.d.ts`) with guidelines and previews, 43 icons and 4 logo files |
| [`designs/`](designs/README.md) | 156 product design artboards across 9 pages (a coverage index, AI agents, editor, collaboration, prototype and handoff, dashboard and onboarding, self-hosting and admin, states and devices, building blocks), in light and dark themes |

## Viewing the designs locally

```sh
python3 -m http.server 8000
```

Then open:

- http://localhost:8000/designs/ to browse every artboard
- http://localhost:8000/design-system/ for live component previews, icons and logos

The viewers load React 18 from cdn.jsdelivr.net and fonts from Google Fonts.

## Provenance

These files were imported on 2026-11-12 from the project's original PRD document, design-system artifact and design canvas. They are now the source of truth: change them here, through pull requests. `design-system/design-system.json` and `designs/canvas.json` are the original index files, kept for their metadata (asset list, artboard frames, pages and section titles).
