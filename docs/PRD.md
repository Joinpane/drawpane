# Drawpane — Product Requirements Document

Nov 12, 2026 · Owner: Ziyang · Status: Draft v0.1

## TL;DR

Drawpane is an open-source design and prototyping tool that anyone can deploy to their own Cloudflare account in minutes, and that runs for cents when idle. It starts as a hard fork of Penpot (`github.com/Joinpane/drawpane`). It keeps Penpot's open file model, its shared `common` logic and its WASM renderer, and replaces everything else: the JVM backend becomes Workers + Durable Objects, and the interface becomes a new design system built for speed and focus.

We are making four bets:

1. **Serverless-native beats self-hosted.** A Penpot install is an always-on JVM, Postgres, Redis and nginx. A Drawpane install is one `wrangler deploy`. Idle teams cost only their storage, and busy teams scale with no capacity planning.
2. **A genuinely better editor.** We don't aim for parity with a new coat of paint. Drawpane ships interaction ideas neither Figma nor Penpot has: a command-first canvas, in-context properties, live branching, and a single model for tokens, variables and code.
3. **Open by default.** The license is MPL-2.0 and the file format is documented. Designs are SVG, CSS and JSON underneath, so nobody's work is ever locked in, including ours.
4. **Agents as collaborators.** AI agents, built in or connected over MCP, join the file like a person: with a cursor, on their own branch, using the same typed operations as the command bar. People review and merge their work. See "AI agents, natively" below.

The first public milestone (v0.1, Q2 2027) is a single-team editor with real-time collaboration, components, auto layout, prototyping and Penpot file import, deployable to a free or $5 Cloudflare plan.

The visual language (tokens, components, icons, logo and a full editor mock-up) lives in the [Drawpane Design System](../design-system/README.md) (full editor screens are in [`designs/`](../designs/README.md)). It uses warm Paper and Graphite neutrals with a single safety-orange accent, `signal`, which always means "you": your selection, your tool and your primary action.

## Problem and opportunity

Teams that want an open design tool today must choose between Figma's price and lock-in and Penpot's performance and hosting weight. Nobody offers a tool that is open, fast and nearly free to run.

**Figma is powerful but expensive, closed and AI-led.**

- A Full seat costs $16/month on Professional (raised from $15 in October 2026), $55 on Organization and $90 on Enterprise ([Toolradar](https://toolradar.com/tools/figma/pricing), [Costbench](https://www.costbench.com/software/ai-design-tools/figma-ai/)). Seat types (Full, Dev, Collab) make bills hard to predict.
- Config 2026 (June 24) pushed Figma toward a platform for AI and generated media: Code Layers, Figma Motion, shader fills, generative plugins, Weave tools and the Figma agent ([CMSWire](https://www.cmswire.com/digital-experience/figma-launches-code-layers-motion-at-config-2026/)). That's impressive, but the core editing loop gets less attention, and files remain in a proprietary format.
- Self-hosting isn't possible, which matters for data residency and regulated teams.

**Penpot is open but heavy and slower to feel right.**

- Self-hosting means running a JVM backend, Postgres, Redis, an exporter and nginx on at least a 4 GB server. Self-hosters report lagging behind cloud releases.
- Performance is the most common complaint, and the new WebGL renderer was still an opt-in beta in mid-2026 ([Penpot community](https://community.penpot.app/t/not-a-roadmap-but-whats-coming-in-penpot-june-2026/10628)).
- The UI is functional but dense, and it borrows many of Figma's patterns without improving on them.

**The opening.** Cloudflare's Workers, Durable Objects, D1 and R2 can now run a real-time multiplayer editor with no servers. Penpot's MPL-2.0 frontend and shared logic give us a two-year head start on the editor itself. A tool that is open like Penpot, at least as polished as Figma, and deploys in one command onto infrastructure that costs cents at rest doesn't exist yet.

## Vision and product principles

**Vision: the design tool you own.** It should be as fluid as the best native app, as open as a text file, and as cheap to run as a static site.

These seven principles settle product arguments. When two features conflict, the principle higher on the list wins.

1. **Fast is a feature.** Every direct-manipulation interaction responds within one frame (16 ms), and every panel or command within 100 ms. A performance regression is a P0 bug.
2. **Canvas first, chrome last.** The work fills the screen. Controls appear where your attention already is, at the selection, and recede when you're not using them.
3. **Keyboard-native, pointer-friendly.** Every action can be reached from the command bar. Nothing requires the keyboard, but experts are never slowed down by the mouse.
4. **Design is shaped like code.** Layout maps 1:1 to CSS flexbox and grid. Tokens, variables and CSS custom properties are one concept. What you see in Inspect is what ships.
5. **You own your work.** The file format is open and documented, export is lossless, and self-hosting takes one command. No feature depends on our hosted service.
6. **Calm collaboration.** Multiplayer tells you who is where and what changed, without demanding attention. Presence is ambient, and notifications are batched.
7. **AI is a tool, not the product.** AI features are optional and can use your own model or MCP client. Drawpane never requires a model to design, and never sends a file anywhere without consent.

## Target users and personas

The primary user is a product designer on a team of 2 to 50. The primary buyer is the engineer or founder who decides where tools run. Drawpane wins when both are happy: the designer has to love it, and the engineer has to be able to deploy it in an afternoon.

| Persona | Who they are | What they need from Drawpane | What makes them switch |
| --- | --- | --- | --- |
| **Maya, product designer** (primary user) | Designs in Figma all day at a 30-person startup | Speed on big files, auto layout that behaves like CSS, components and variants, solid prototyping | It feels faster and calmer than Figma, and imports her files |
| **Dev, platform engineer** (primary buyer) | Owns infra and the tool budget at the same startup | One-command deploy, SSO, backups, a bill that stays near zero | `npx create-drawpane` onto their existing Cloudflare account, about $5–20/month instead of $480+/month in Figma seats |
| **Lena, design-systems lead** | Maintains tokens and a component library used by 4 product teams | Tokens that sync to code, library versioning, branching and review | Tokens, variables and CSS are one model; branches merge like Git |
| **Sam, front-end developer** | Implements designs and reviews specs | Accurate CSS, token names in Inspect, no paid Dev seat | Inspect shows the real tokens and CSS, free for every viewer |
| **Ops at a regulated org** (secondary) | Public sector, health or finance, with data-residency rules | Self-hosting, audit logs, region pinning | Runs inside their own Cloudflare account with jurisdiction-restricted storage |
| **Open-source maintainer** (secondary) | Runs a community project with volunteer designers | Free, public files, easy contributor onboarding | Free to host, public read links, GitHub login |

Out of scope for v1: illustrators who need advanced vector brushes, print designers, and motion designers who need a timeline.

## Goals, non-goals and success metrics

Success at 12 months means 1,000 self-hosted deployments and designers who choose Drawpane over Figma for daily work, not only because it's free.

**Goals**

1. Ship a daily-driver UI design tool: vectors, text, components, variants, auto layout, prototyping and Inspect.
2. Run fully on Workers, Durable Objects, D1, R2 and Queues, with no containers or VMs in production.
3. Deliver a visibly better editing experience than both Figma and Penpot on speed, focus and layout.
4. Make migration painless: import `.penpot` files and Figma files (via `.fig` parsing or the REST API), and export SVG, PNG, PDF and CSS.
5. Keep the fork economical: track Penpot's `common` and renderer, and contribute fixes upstream where they apply.

**Non-goals for v1**

- Whiteboarding (FigJam-style), slides or sites. Revisit after v1.
- A native desktop app. A PWA with offline support is enough.
- Bundling a hosted AI model. AI comes through MCP and bring-your-own keys.
- Drop-in API compatibility with Penpot's backend or plugin API. We keep file compatibility, not wire compatibility.
- Running on non-Cloudflare platforms. Portability is welcome later through a storage adapter, but it won't shape v1.

**Success metrics**

| Metric | Target at v1.0 (12 months) | How we measure |
| --- | --- | --- |
| Self-hosted deployments | 1,000 active | Opt-in, anonymous deploy ping |
| GitHub stars | 10,000 | GitHub |
| Weekly active editors (hosted demo plus opted-in installs) | 5,000 | Opt-in telemetry |
| Time from clone to working deploy | Under 10 minutes, median | Scripted test plus user survey |
| Idle team cost | Under $0.10/month | Cloudflare billing for a reference team |
| Canvas frame time on a 10k-layer file | p95 under 16 ms while panning | Automated benchmark in CI |
| Collaboration latency (edit to peer render) | p95 under 150 ms in the same region | Synthetic two-client test |
| Penpot file import fidelity | 99% of a 500-file corpus opens with no visual diff | Visual-diff test suite |
| Designer preference vs Figma | At least 60% prefer Drawpane on a timed task set | Moderated usability study |

## Positioning against Figma and Penpot

**Drawpane is the open design tool that feels better than Figma and costs less than a coffee to run.** We compete on editor quality and ownership, not on an AI or generated-media feature race.

|  | Drawpane | Figma | Penpot |
| --- | --- | --- | --- |
| License | MPL-2.0 | Proprietary | MPL-2.0 |
| Hosting | Your Cloudflare account, one command; optional hosted service | Figma cloud only | Their cloud, or self-host JVM + Postgres + Redis |
| Cost for a 10-designer team | About $5–10/month of infrastructure | $160/month on Professional, $550 on Organization | Free cloud plan, or about $25–60/month for a self-host server |
| Idle cost | Cents (storage only) | Seats are billed regardless | Always-on server |
| File format | Open; SVG, CSS and JSON underneath | Proprietary `.fig` | Open; SVG, CSS and JSON |
| Layout model | CSS flex and grid, 1:1 | Auto layout (flex-like) plus grid | CSS flex and grid |
| Tokens | Tokens, variables and CSS variables are one model | Variables, separate from styles | Native tokens (W3C DTCG), separate from styles |
| Branching | Live branches with visual merge, on every plan | Organization plan and up | Candidate on roadmap |
| Dev handoff | Free Inspect for all viewers | Paid Dev seat | Free Inspect |
| AI | Optional, BYO model, MCP-native | Built-in agent, credits per seat | MCP server |

Figma prices are list prices for Full seats as of October 2026. Our angle against Figma is ownership and a calmer, faster editor. Against Penpot, it's polish, performance and an infrastructure footprint close to zero.

## Signature UX innovations

Eight ideas make Drawpane feel different within the first five minutes. Each one has to beat both Figma and Penpot on a timed task before it ships. Phase tags refer to the roadmap below.

1. **Command line for design** (v0.1). `⌘K` opens one bar that runs actions, jumps to layers, and sets properties with a short syntax: `w 320`, `gap 16`, `fill brand/500`, `radius sm`. Every numeric field accepts math and units (`24*2`, `1.5rem`). Figma's quick actions find commands but don't set values.
2. **Selection Lens** (v0.1). A compact floating strip anchored to the selection shows the 4–6 controls that matter for that layer type (text: font, size, weight, color; frame: layout, gap, padding, fill). The full inspector stays one keypress away. Your eyes stay on the work instead of travelling to a 240 px panel.
3. **Layout X-ray and Explain** (v0.1). Hold `Alt` to overlay padding, gaps, alignment and sizing modes on the canvas, and drag them directly. Click any dimension to see why it is that size, traced through the Hug, Fill and Fixed chain like browser devtools. No current tool explains layout results.
4. **Live branches with visual diff** (v0.2). Branching a file is instant, because a Durable Object forks from a revision. Review shows side-by-side, overlay and swipe diffs, lets you accept change by change, and anchors comments to changes. Figma limits branching to the Organization plan, and Penpot doesn't have it.
5. **History scrubber with layer-level restore** (v0.2). Every save is already an ordered change log in the file's Durable Object. A timeline scrubber replays the file, and any single layer can be restored to any point without rolling back teammates' work.
6. **One token model** (v0.1 base, v0.3 sync). Tokens, variables, modes and styles are a single concept. They appear as chips inside property fields, show usage counts, and export directly as CSS custom properties and W3C DTCG JSON, with GitHub sync.
7. **Breakpoint strip** (v0.3). Show any board at several widths side by side, live-linked, so a responsive layout can be tuned in one view. Breakpoints export as CSS media or container queries.
8. **Calm multiplayer** (v0.1). Cursors fade after 3 seconds idle. Presence also shows up in the layer tree and minimap, so you can see where people are without them crowding your viewport. Follow mode and a one-key "hide others" focus mode are built in.

Accessibility is designed in rather than added as a feature: contrast ratios sit inside the color picker, touch-target warnings appear at selection, and focus order can be annotated and exported.

## AI agents, natively

In Drawpane an AI agent is a collaborator in the file, not a plugin bolted onto it. It joins the same real-time room as people, works on its own branch, and uses the same typed operations as the command bar. Everything it does can be reviewed, attributed and undone.

**Where Figma and Penpot are today**

- **Figma** opened its canvas to outside agents on March 24, 2026. MCP clients write through the `use_figma` tool, which runs JavaScript inside the file through the Plugin API ([Figma developer docs](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas)). Writing to the canvas is free during the beta, is planned to become usage-based, and needs a Full seat outside drafts ([Developers Digest](https://www.developersdigest.tech/mcp-servers/figma)). Figma's own agent reached open beta at Config on June 24 with custom skills and connectors ([rar.design](https://rar.design/posts/figma-agent-complete-guide)). Skills are markdown files that encode a team's conventions ([Muzli](https://muz.li/blog/figma-just-opened-the-canvas-to-ai-agents-heres-what-it-means-for-designers/)).
- **Penpot** offers a free, open MCP server that works with any client and any model ([Penpot](https://penpot.app/ai/mcp-server)). The server reaches the file through a Penpot MCP plugin that connects over WebSocket and runs each task through the Plugin API ([Penpot MCP README](https://glama.ai/mcp/servers/fwnvmvjryb)).

Both route agents through a scripting path built for plugins. Agents edit the live file directly, and their work arrives as a stream of edits with no review step built in. Drawpane changes the structure instead.

|  | Figma | Penpot | Drawpane |
| --- | --- | --- | --- |
| How agents edit | JavaScript through the Plugin API | Plugin API, through an MCP plugin open in Penpot | Typed operations sent to the file's Durable Object and validated by `common` before they apply |
| Where changes land | In the file | In the file | On the agent's own branch, merged after review |
| Which models | Figma's agent, or any MCP client | Any MCP client and model | Any MCP client and model, plus a built-in agent that uses your own key or Workers AI |
| Cost to the team | AI credits; write-to-canvas planned usage-based | Free | Free; model usage is billed by your provider |
| Self-hosting | No | Yes | Yes, in your own Cloudflare account |

**Seven rules for agents**

1. **Agents are collaborators.** An agent has a cursor, a selection and a name tag in the room, drawn in the `agent` color with a dashed outline. Its revisions are attributed: "Claude, for Ana".
2. **Branch by default.** Every agent session works on a new branch. Merging needs a person; teams can allow automatic merges for safe operations like renaming layers.
3. **One action language.** The command bar syntax, the MCP tools and plugin API v2 share one typed operation set (`set gap 16`, `bind fill brand/500`, `insert Button variant=primary`). Operations are validated, replayable and cheap in tokens. No arbitrary scripts.
4. **Design system first.** Tools list the file's components and tokens, so agents build with real parts. A lint gate blocks a merge with detached values or contrast failures, and each proposal shows how much of it uses the system.
5. **Agents see their work.** A render tool returns a PNG of any frame on the branch, so an agent can check its output before asking for review.
6. **Bring your own agent and model.** Every instance serves a remote MCP server. The built-in agent works with Anthropic, OpenAI, Workers AI or any OpenAI-compatible endpoint, including a local one. There are no credits.
7. **Governed by default.** Tokens and sessions are scoped per file. Admins set approval rules and monthly budgets. Every action is in the audit log. File content stays in your account and is never used for training.

![How agent work flows · 2 entry points, 1 branch, 1 review](diagrams/agent-flow.svg)

The built-in agent and outside MCP clients reach the same tools. Neither can change main without a person approving the review.

**Where agents show up**

- **Agent pane** in the editor: a plan with live steps, the agent's cursor on the canvas, and Stop at any point.
- **Natural language in the command bar:** "make these cards a 3-column grid from 1280" previews the exact operations before anything runs.
- **@drawpane in comments:** ask for a change in a thread and get a proposal back in the same thread.
- **Explore directions:** start 2–4 agents on parallel branches and compare the results side by side.
- **Skills library:** team-written markdown skills ("Audit accessibility", "Localize to German", "Add empty and error states"), versioned with the library and portable to other tools.
- **Automations:** scheduled agents such as a nightly accessibility audit or a weekly token-sync pull request, run with Workflows and Cron Triggers.
- **Design and code:** generate a pull request from a frame using your real components, or bring a running page back as editable layers.

**MCP tools in the first release**

| Group | Tools | Needs approval |
| --- | --- | --- |
| Read | `get_outline`, `get_node`, `find_nodes`, `list_components`, `list_tokens`, `get_comments`, `get_history`, `render_frame` | No |
| Write on a branch | `start_branch`, `apply_ops`, `insert_component`, `bind_token`, `reply_comment` | No; runs on the agent's branch |
| Ship | `request_review`, `merge_branch`, `publish_library` | Yes, a person approves |

**Agent requirements**

| Requirement | Phase |
| --- | --- |
| Remote MCP server with OAuth and scoped personal tokens; read tools and branch writes | v0.2 |
| Agent presence in the room: cursor, selection, name tag, attributed revisions | v0.2 |
| Built-in agent pane with plan, live steps and Stop; bring-your-own key and Workers AI | v0.3 |
| Natural-language commands with an operation preview; @drawpane in comments | v0.3 |
| Skills library and editor; design-system lint gate on merge | v0.3 |
| Explore directions on parallel branches; scheduled automations; budgets and approval rules | v1.0 |
| Design-to-code pull requests and code-to-design import | v1.0 |

**Agent success metrics**

| Metric | Target at v1.0 |
| --- | --- |
| Agent proposals merged, in whole or in part | At least 60% |
| Values in merged agent work bound to tokens | 100% (enforced by the lint gate) |
| Merged agent changes reverted within 7 days | Under 5% |
| Time from prompt to a reviewable proposal for one screen | Under 60 s, median |
| MCP clients tested in CI | Claude Code, Cursor, Codex, VS Code |

**Agent risks**

- **Prompt injection from file content.** Layer names and comments are treated as data. Tools are scoped, and anything that ships needs a person.
- **Runaway cost.** Per-team monthly budgets, per-session limits and AI Gateway caching keep model spend predictable.
- **History noise.** An agent session collapses into one revision when merged, and its steps stay viewable inside it.
- **Uneven model quality.** The lint gate and render-and-check loop catch weak output before review, whichever model is used.

## Functional requirements

Most editor capability comes from Penpot's frontend and `common`, behind a new interface. Everything server-side is new. Phases: **v0.1** alpha (April 2027), **v0.2** beta (July 2027), **v0.3** (September 2027), **v1.0** (November 2027).

Origin key: **Inherit** means Penpot code reused behind new UI. **Rebuild** means the same capability with a new implementation. **New** means it doesn't exist in Penpot.

| Area | Requirement | Phase | Origin |
| --- | --- | --- | --- |
| Canvas | Boards, shapes, pen and path editing, booleans, masks, images, groups | v0.1 | Inherit |
| Canvas | WASM/WebGL renderer as the only renderer; 10k-layer files pan at 60 fps | v0.1 | Inherit + tune |
| Canvas | Fills, strokes, gradients, shadows, layer and background blur | v0.1 | Inherit |
| Text | Rich text, OpenType features, Google Fonts and uploaded fonts | v0.1 | Inherit; font conversion rebuilt in WASM |
| Text | Variable fonts, text on path | v1.0 | New |
| Layout | Flex and grid layout, constraints, min/max sizing | v0.1 | Inherit |
| Layout | Layout X-ray and Explain | v0.1 | New |
| Layout | Breakpoint strip, exportable media and container queries | v0.3 | New |
| Components | Main components, instances, overrides, variants | v0.1 | Inherit |
| Components | Slots, component playground with auto-generated state matrix | v0.3 | New |
| Libraries | Shared team libraries with versioned publish and update review | v0.2 | Rebuild |
| Tokens | One model for tokens, variables, modes and styles; DTCG import and export | v0.1 | Inherit + rebuild UI |
| Tokens | Two-way GitHub sync of tokens | v0.3 | New |
| Prototyping | Interactions, flows, overlays, present mode, shareable prototype links | v0.1 | Inherit |
| Prototyping | Smart animate, scrollable boards, device preview over QR | v0.3 | New |
| Collaboration | Real-time multiplayer editing, presence, follow mode | v0.1 | Rebuild on Durable Objects |
| Collaboration | Comments, mentions, resolve; email digests | v0.1 | Rebuild |
| Collaboration | Live branches, visual diff, review and merge | v0.2 | New |
| Collaboration | History scrubber, named versions, layer-level restore | v0.2 | New |
| Handoff | Inspect with CSS, SVG and token names, free for viewers; asset export (PNG, JPG, WebP, SVG, PDF) | v0.1 | Inherit; export runs client-side |
| Import | `.penpot` v3 import and export | v0.1 | Inherit |
| Import | Figma import via `.fig` file and REST API | v0.2 | New |
| Workspace | Dashboard with teams, projects, files, search, trash, templates | v0.1 | Rebuild UI |
| Workspace | Command bar, Selection Lens, focus mode, customizable shortcuts | v0.1 | New |
| Accounts | Email with passkeys, GitHub and Google login, invites, roles (owner, editor, viewer) | v0.1 | Rebuild |
| Accounts | OIDC and SAML SSO, SCIM, audit log | v1.0 | New |
| Extensibility | Full Penpot plugin API compatibility; Drawpane extensions under a separate namespace | v0.3 | Inherit + adapt |
| Extensibility | Public REST API, webhooks, MCP server for AI clients | v0.2 | New |
| Offline | Installable PWA; edits queue offline and merge on reconnect | v1.0 | New |
| Self-host | `npm create drawpane` installer, one-command upgrade, R2 backups, health page | v0.1 | New |

## Non-functional requirements

Performance and data safety are release blockers. Every target below has an automated check in CI or in a nightly benchmark.

| Area | Requirement |
| --- | --- |
| Canvas performance | p95 frame time under 16 ms while panning and zooming a 10,000-layer file on a 2022 MacBook Air (M2) |
| File open | Under 1.5 s to first interactive canvas for a 5 MB file on a warm cache; under 3 s cold |
| Save latency | p95 under 200 ms from local edit to durable commit in the file's Durable Object |
| Collaboration latency | p95 under 150 ms edit-to-peer render in the same region; pointer updates throttled to 50 ms |
| Memory | Each Durable Object stays under 96 MB, below the 128 MB isolate limit, by loading only the pages a change touches |
| Durability | Zero acknowledged edits lost. Durable Object storage is the source of truth, with hourly snapshots to R2 and 30-day point-in-time restore |
| Availability | 99.9% monthly for the hosted service; self-hosted availability inherits Cloudflare's |
| Security | Passwords hashed with argon2id; session cookies HttpOnly and SameSite; CSP on all pages; file access checked on every Durable Object request; plugins sandboxed in iframes |
| Privacy | No telemetry by default on self-hosted installs; the hosted service collects only product analytics, never file contents |
| Data residency | Self-hosters can pin Durable Objects and R2 to EU or FedRAMP jurisdictions |
| Accessibility | Product UI meets WCAG 2.2 AA: full keyboard operation, visible focus, screen-reader labels on every control, reduced-motion support |
| Internationalization | All UI strings externalized from v0.1; right-to-left layout by v1.0; reuse Penpot's existing translations where the strings carry over |
| Browser support | Latest two versions of Chrome, Edge, Firefox and Safari; WebGL2 required |

## Architecture on Cloudflare

Drawpane runs entirely on Cloudflare: one Worker, two Durable Object classes, D1, R2 and Queues, with no containers. The file's Durable Object replaces Penpot's Postgres advisory lock, its Redis message bus and its websocket server.

![Drawpane on Cloudflare · 1 Worker, 2 Durable Object classes, D1, R2](diagrams/architecture.svg)

Only the FileRoom holds a file's live state. Everything else is stateless or managed storage, so it scales to zero.

**How an edit flows**

1. The client applies a change locally and sends the batch with its base revision (`revn`) over the file's websocket.
2. The FileRoom applies it with upstream's `app.common.files.changes`, validates it, appends it to the change log in SQLite and bumps `revn`. Requests run one at a time, so no lock is needed.
3. The FileRoom broadcasts the change to every connected socket. A client that fell behind receives the changes it missed.
4. An alarm writes an R2 snapshot every hour and trims the log behind it.

**Key design decisions**

- **Plain data on disk.** We never enable Penpot's `fdata/pointer-map` or `fdata/objects-map` backend features, so file data stays in transit format and no JVM-only codecs are needed.
- **Page-level rows.** Each page is its own SQLite row, and a save loads only the pages it touches. This keeps the FileRoom under its memory budget.
- **Branches are new FileRooms** seeded from an R2 snapshot at the base revision. Merging replays one branch's change log onto the other, with conflicts surfaced per layer.
- **Auth at the edge.** The Worker validates the session and passes a signed, short-lived claim (user, file, role) to the Durable Object, which checks it on every connection.
- **Websocket URL includes the file id** (`/ws/files/:id`), so sockets route straight to the right FileRoom. This is a deliberate break from Penpot's single `/ws/notifications` endpoint.

## Upstream strategy, licensing and brand

We fork the whole repository with history, then track Penpot at three depths. Shared logic is merged on every release, editor internals are cherry-picked, and the UI, backend and branding are ours alone.

| Upstream path | How we track it | Why |
| --- | --- | --- |
| `common/` (file model, changes, validation, migrations) | Merge on every Penpot release (six-week cadence), via an automated PR | This is the file format. Drifting from it breaks `.penpot` compatibility |
| `render-wasm/` (Rust/WASM renderer) | Merge on every release | Upstream is investing heavily here; it's our performance foundation |
| `frontend/` data layer (tools, layout, workspace state) | Cherry-pick selected commits | Valuable fixes land here, but it's coupled to Penpot's UI |
| `frontend/` UI components and styles | Replace; don't track | The new design system lives in `ui/` |
| `backend/`, `exporter/`, `docker/` | Delete; use as a CI test oracle only | Replaced by Workers and Durable Objects |

**How to keep merges cheap**

- Never edit files in `common/` or `render-wasm/` in place. Extend through new namespaces, and send real fixes upstream as pull requests.
- Put a thin adapter (`frontend/src/drawpane/api`) between Penpot's data layer and our backend, so RPC changes upstream touch one file.
- A sync bot opens a PR on each upstream tag and runs the 500-file import corpus, the visual-diff suite and the websocket conformance test. A red build blocks the merge.

**Licensing (MPL-2.0).** MPL is file-level copyleft. Every Penpot file we modify stays MPL-2.0, keeps its original copyright header, and must have its source published. We'll license all new code MPL-2.0 as well, so the project has a single license. The repo gets a `NOTICE` file crediting Penpot and Kaleidos. We use DCO sign-off, not a CLA. This is not legal advice; have a lawyer review before the first public release.

**Brand separation.** Penpot is Kaleidos's trademark, so Drawpane ships with none of Penpot's name, logo, illustrations, colors or marketing copy. A factual credit ("Drawpane started as a fork of Penpot") in the README and About screen is fine. A web search found no design product named Drawpane, only a `DrawPane` class in the SmartGWT library. A formal USPTO and EUIPO search is still needed before launch.

## Cost targets and hosting model

A 10-editor team should run Drawpane for about the price of the Workers Paid plan ($5/month), and an idle team should cost only its storage. Infrastructure cost is a product requirement, so a change that raises the reference team's bill by more than 10% needs sign-off.

| Team size | Drawpane infra budget | Biggest cost driver | Figma Professional list price (Full seats) |
| --- | --- | --- | --- |
| 10 editors | ≤ $10/month | Workers base plan | $160/month |
| 50 editors | ≤ $40/month | Durable Object row writes from saves | $800/month |
| 500 editors | ≤ $250/month | Row writes (about $80) and R2 storage for 1 TB | $8,000/month |

The budgets assume 4 hours of editing a day for 22 days a month, as in the earlier cost model. They are targets, not measurements.

**Cost guardrails built into the design**

- Each editor's websocket connects straight to the file's Durable Object, which fans out to peers. Outbound websocket messages aren't billed, so pointer traffic costs about $10/month at 500 editors instead of about $380 with per-user relay objects.
- Saves are coalesced on the client (300 ms debounce) and each page is stored as its own row, which keeps row writes per save low.
- Durable Objects hibernate when no one is connected, so idle files incur no duration charges.
- The frontend is static assets, which are free to serve. Exports render in the browser, so there's no Chromium bill.
- Snapshots and media go to R2 ($0.015/GB-month, no egress fees), not Durable Object storage.

**Hosting model**

1. **Self-host (primary, v0.1).** `npm create drawpane` provisions Workers, Durable Objects, D1, R2 and Queues in the user's own Cloudflare account and runs migrations.
2. **Public demo (v0.1).** A shared instance with file deletion after 7 days, for trying the product without deploying.
3. **Hosted service (optional, after v1.0).** A managed multi-tenant version could fund development. The architecture already supports it, because idle tenants cost cents. This decision is deferred.

## Open source, repo layout and governance

Drawpane launches as `github.com/Joinpane/drawpane` under MPL-2.0. It moves to a `drawpane` GitHub organization once it has three or more regular maintainers.

```
drawpane/
  common/        Penpot shared file model (tracked, never edited in place)
  render-wasm/   Penpot WASM/WebGL renderer (tracked)
  frontend/      Penpot editor data layer (forked) + drawpane/api adapter
  ui/            @drawpane/ui — design system: tokens, components, icons, Storybook
  app/           New shell: dashboard, workspace chrome, command bar, Lens
  worker/        Workers router: auth, REST API, static assets, websocket upgrade (TypeScript)
  durable/       FileRoom DO and TeamHub DO in TypeScript, calling compiled common/
  cli/           create-drawpane installer and upgrade tool
  oracle/        CI-only: upstream Penpot backend in a container for contract tests
  docs/          User guide, self-hosting guide, file-format spec, RFCs
```

**Governance**

- **Decision-making:** a single lead maintainer (dizys) has final say until v1.0. After that, a maintainer council of 3–5 people.
- **RFCs:** changes to the file format, the public API or the design system need a short RFC in `docs/rfcs/` with a 7-day comment window.
- **Design review:** any pull request that changes UI must include a before/after recording and pass a design-system lint (tokens only, no raw hex values, no off-scale spacing).
- **Contributions:** DCO sign-off, Contributor Covenant code of conduct, and "good first issue" labels from day one.
- **Releases:** semantic versioning, with a minor release every 4 weeks and patch releases as needed. Each release notes which Penpot tag it is synced to.
- **Community:** GitHub Discussions for questions and ideas, and a public roadmap on GitHub Projects.

## Roadmap and milestones

A usable alpha lands in April 2027 and v1.0 in November 2027, provided the six-week M0 spike proves Penpot's `common` runs inside a Durable Object.

![Drawpane roadmap · 5 phases, 4 gates, Dec 2026 to Nov 2027](diagrams/roadmap.svg)

Each diamond is a gate that must pass before the next phase starts. If the M0 gate fails, we fall back to validating changes on the client, which adds about four weeks. These dates assume one full-time maintainer plus part-time contributors from v0.2, and they are rough estimates.

## Risks and open questions

The biggest risk is technical and comes first: Penpot's `common` code might not run inside workerd. The M0 spike exists to answer that within six weeks.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `common` touches browser-only globals and won't run in workerd | Medium | High | M0 spike: load a real file, apply changes, validate and migrate inside a Durable Object. Fallback: validate on the client, and have the DO only order and persist changes |
| Large files exceed the 128 MB Durable Object memory limit | Medium | High | Store each page as a row and load only touched pages; split very large files across several DOs |
| Upstream refactors make merges expensive | Medium | Medium | Track only `common` and `render-wasm` closely; adapter layer; automated sync PRs with corpus tests |
| Figma's `.fig` format changes or import raises legal questions | Medium | Medium | Use the official REST API as the supported path, with `.fig` parsing best-effort; get legal review |
| A solo maintainer can't sustain the scope | High | High | Hard scope cuts for v0.1; recruit 2 co-maintainers before v0.2; use the hosted demo to build community |
| "Cloudflare-only" puts off some self-hosters | Medium | Low | Document why; keep storage behind interfaces so a workerd + SQLite + S3 target is possible later |
| Cloudflare pricing or limits change | Low | Medium | Cost tests in CI against the reference team; architecture uses only GA products |
| Name or trademark conflict for "Drawpane" | Low | Medium | USPTO and EUIPO search before public launch; secure domain and npm scope now |

**Decisions (November 12, 2026)**

| Question | Decision | What it changes |
| --- | --- | --- |
| UI component stack | TypeScript + React for `@drawpane/ui` | The design system bundle is already React; `ui/` gets Storybook and is consumed from the editor |
| Domain and npm scope | `drawpane.com` is owned; branding work waits | Nothing until launch prep |
| Penpot plugin API | Full compatibility as the starting point | v0.3 runs Penpot plugins unmodified through a `penpot` global; Drawpane-only APIs live under a separate `drawpane` global |
| Paid hosted tier | Not yet; revisit once the repo has momentum | Hosted service stays deferred; no feature gating anywhere |
| Language for the FileRoom and new code | TypeScript for all new code | `durable/` is TypeScript calling compiled `common`; porting `common` itself is a later, separate decision |

## Sources

- [Penpot repository](https://github.com/penpot/penpot) (MPL-2.0)
- [What's coming in Penpot, June 2026](https://community.penpot.app/t/not-a-roadmap-but-whats-coming-in-penpot-june-2026/10628)
- [Penpot 2.18 and Penpot Enterprise](https://alternativeto.net/news/2026/9/penpot-2-18-brings-enterprise-and-stroke-to-path-tools/)
- [Figma pricing, verified October 2026](https://toolradar.com/tools/figma/pricing) and [seat-level pricing](https://www.costbench.com/software/ai-design-tools/figma-ai/)
- [Figma Config 2026 announcements](https://www.cmswire.com/digital-experience/figma-launches-code-layers-motion-at-config-2026/)
- Earlier analysis in this project: Cloudflare feasibility, Workers-only rewrite and cost comparison (Cloudflare limits and pricing pages cited there)
- [Figma: write to canvas (use\_figma)](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas) and [Figma MCP server pricing notes](https://www.developersdigest.tech/mcp-servers/figma)
- [Figma agent timeline and skills](https://rar.design/posts/figma-agent-complete-guide) and [skills as markdown](https://muz.li/blog/figma-just-opened-the-canvas-to-ai-agents-heres-what-it-means-for-designers/)
- [Penpot MCP server](https://penpot.app/ai/mcp-server) and [its plugin-based architecture](https://glama.ai/mcp/servers/fwnvmvjryb)
