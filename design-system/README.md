# Drawpane design system

> Brand book for the Drawpane interface. Live component previews: [`index.html`](index.html) (serve the repo over HTTP). Tokens: [`tokens.json`](tokens.json) (source) and [`tokens.css`](tokens.css) (generated CSS variables, Paper = light, Graphite = `[data-theme="dark"]`). Components: [`components/`](components). Icons and logos: [`assets/`](assets).

Drawpane's interface is a quiet drafting table: warm paper or graphite neutrals, one safety-orange accent called **signal**, small crisp radii and dense 12px type. The design on the canvas is always the loudest thing on screen. The chrome stays calm, precise and fast.

Five rules shape every screen:

1. **Canvas first, chrome last.** Panes float over the `canvas` and can collapse to a 40px rail (`size-rail`). Never add a full-width bar.
2. **One accent.** `signal` means "you": your selection, your active tool, the one primary action, keyboard focus. Nothing else uses it.
3. **Keyboard-native.** Every action is reachable from the CommandBar. Every tooltip and menu item shows its shortcut.
4. **Shaped like code.** Layout controls mirror CSS flexbox and grid, token names are shown as developers will type them, and Inspect shows real CSS.
5. **Calm multiplayer.** Collaborators, people and agents, are ambient: presence colors, fading cursors, dots in the layer tree. Never a modal, never signal.

## Content fundamentals

- **Voice:** a precise colleague. Short, plain and specific. Talk to the user as "you"; Drawpane refers to itself as "Drawpane", never "we".
- **Casing:** sentence case everywhere, including buttons, menu items, section titles and dialog titles. Never use all caps, including in field labels.
- **Labels:** buttons are verb-first and 1–3 words ("Publish library", "New branch"). Section titles are nouns ("Auto layout", "Fill").
- **Numbers:** always with units when they aren't px ("12", "1.5rem", "50%"). Use tabular figures in fields and tables. Use × for dimensions ("300 × 196").
- **Errors** say what happened and what to do next, in one sentence: "That address is already on this team." Never "Invalid input" or "Oops".
- **Empty states** give one line of explanation and one action. Headlines may use `display-md`; the body uses `page-body`.
- **No emoji** in product UI or system messages. No exclamation marks except in a user's own content.

| Instead of | Write |
| --- | --- |
| Click here to add a new component | Create component |
| Oops! Something went wrong. | Couldn't save. Check your connection; your edits are kept locally. |
| SETTINGS | Settings |
| Are you sure? | Delete "Checkout flow"? This can't be undone. |

## Visual foundations

### Color

- **Grounds.** `canvas` is behind the design. `surface` is every pane. `surface-sunken` holds field wells. `surface-raised` is for anything floating above a pane (menus, the Lens, dialogs). `surface-inverse` is only for tooltips and toasts.
- **Text.** `ink` for content and values, `ink-muted` for labels and placeholders. Both pass 4.5:1 on `surface`, `surface-sunken`, `surface-raised` and `surface-hover` in both themes. Icons default to `icon` (3:1 or better).
- **Signal.** A `signal` fill always carries `on-signal` text (dark ink). White on signal fails contrast, so never use it. Signal as text or a thin mark uses `signal-ink`. A selected row uses `signal-soft` with `ink` text.
- **Lines.** `line` hairlines divide sections and are never the only cue. `line-strong` outlines secondary buttons, token chips and the selected segment. `line-control` marks controls that must be found (switch tracks, form inputs) and meets 3:1.
- **Status.** `success`, `warning`, `danger` and `info` always come with an icon and a word. `danger-fill` with `on-danger` is for destructive buttons only.
- **Themes.** Paper (light) and Graphite (dark) carry the same names. Never branch on theme in component code; bind tokens.

### Canvas semantics

The canvas has its own reserved colors, so a mark there tells you what it is without a label:

| Mark | Token |
| --- | --- |
| Your selection, handles, size pill | `signal` (pill text `on-signal`) |
| Main components and instances | `component`, names in `component-ink` |
| Smart guides and measurements | `guide` |
| Layout X-ray padding / gap | `xray-padding` / `xray-gap` at 35% opacity |
| Collaborators' cursors, tags, selections | `presence-1` … `presence-8`, tag text `on-presence` |
| AI agents' cursors, tags, selections | `agent`, tag text `on-agent`, selection dashed |

Selection outlines are 1.5px, with 7px white handles. Collaborators' selections are 1px in their presence color, so yours always reads as primary. An agent's selection is a 1.5px dashed `agent` outline.

### Typography

- **Instrument Sans** (`--font-ui`) is the product face, used for all chrome. Dense UI runs at 12px: `ui-body` for text and values, `ui-strong` for selected names and section titles, `ui-label` (11px) for field labels. `ui-title` is for the file name and popover headings, `ui-heading` for dialog titles.
- **Instrument Serif** (`--font-display`) is for empty states (`display-md`) and the website (`display-xl`). Never use it inside editor chrome.
- **JetBrains Mono** (`--font-mono`) sets token names, CSS in Inspect, the command bar's typed syntax (`code`) and shortcuts (`kbd`).
- All three load from Google Fonts. Field values set `font-variant-numeric: tabular-nums`.

### Spacing and density

- Use a 4px grid only: `space-050` (2) up to `space-1200` (48). Panes pad 12px horizontally (`space-300`). Controls in a row sit 8px apart (`space-200`). Inspector sections are separated by a `line` hairline with 10px above the title.
- **Control heights:** `size-control-sm` (24) for Inspector fields and pane IconButtons, `size-control-md` (28) for buttons, layer rows and command-strip tools, `size-control-lg` (36) for dashboard and dialog controls. Icons are always `size-icon` (16), or 12 inside rows and chips.
- Panes default to `size-pane` (264px) and resize from 224 to 400.

### Radii, panes and elevation

- `radius-xs` (3) for chips, key caps and swatches; `radius-sm` (5) for buttons, fields and rows; `radius-md` (8) for menus, popovers, the Lens and tooltips; `radius-lg` (12) for panes and dialogs. Nothing is rounder than a pane, except avatars and switches (`radius-full`).
- Elevation is a hairline ring plus one soft shadow. Use `shadow-pane` for panes over the canvas, `shadow-popover` for menus, the Lens and the CommandBar, and `shadow-modal` for dialogs. Nothing inside a pane casts a shadow.
- No gradients, glass blur or colored side-borders in chrome.

### Motion

- Motion only confirms cause and effect. Use 90 ms for hover and press, 120 ms for toggles, and 160 ms ease-out for popovers and the Lens appearing. Nothing animates while a user is dragging, scrubbing or panning.
- Respect `prefers-reduced-motion`: replace movement with an instant change.

### States and focus

- **Hover:** `surface-hover`. **Pressed or open:** `surface-active`. **Selected:** `signal-soft`. **Disabled:** `ink-disabled` with a not-allowed cursor.
- **Keyboard focus** is `shadow-focus`: a 1px ground-colored gap, then a solid 2px signal ring, shown on `:focus-visible` only. It meets 3:1 on every surface.
- **Inspector fields** are identified by their `surface-sunken` well and label. They gain a `line-strong` border on hover and a `signal` border while focused.

## Editor anatomy

The Workspace page shows the editor composed from this system:

- **File pane** (top left): mark, file name, current branch as an `info` Badge.
- **Command strip** (top centre): drawing tools as `md` IconButtons, with the active tool pressed, then the CommandBar trigger.
- **Share strip** (top right): PresenceStack, Present, and the view's one primary Button.
- **Layers pane** (left): pages, the LayerRow tree, then local components.
- **Inspector pane** (right): Design / Prototype / Inspect, then PropertySections in a fixed order.
- **Selection Lens:** anchored 12px under the selection, 4–6 controls.
- **Zoom** (bottom centre).

All panes float with 12px margins and collapse to rails, and `\` hides every pane for focus mode.

## Interaction patterns

- **Command first.** `⌘K` runs commands, finds layers and sets values (`w 320`, `gap 16`, `fill brand/500`). Property commands show the old and new value before you press Enter.
- **Selection Lens over panel travel.** Frequent edits happen next to the selection. The Inspector is for everything else.
- **Layout X-ray.** Holding Alt overlays padding and gaps, and you can drag them on the canvas. Clicking a dimension explains how its size came about (Hug, Fill, Fixed).
- **Branches and history.** Branch and History actions live in the Layers pane and the layer context menu. Diffs use `success` for added, `danger` for removed and `info` for changed, each with a word.
- **Presence.** Cursors fade after 3 s idle. Avatars enter follow mode on click.

## Agents

AI agents are collaborators with their own visual identity, so nobody mistakes an agent's edit for a person's, or the other way around.

- **Color:** `agent` (violet) is used only for agents: cursor, name tag (AgentTag), dashed selection outline, the running step in a plan, and the agent pane's accent. Text uses `agent-ink`; tinted rows use `agent-soft`; text on an agent fill uses `on-agent`.
- **Always attributed:** an AgentTag shows the agent and who it works for ("Claude, for Ana") in presence, history, reviews and the audit log.
- **Always on a branch:** agent work shows an `info` branch Badge, and proposals open in review. Nothing an agent does reaches main without a person.
- **Show the operations:** AgentStep lists the typed operations each step applied (`set gap 16`), in `code` style and `agent-ink`.
- **Your action stays signal:** sending a prompt, merging and approving are your actions, so they use `signal`. Stop uses `surface-inverse`.
- **Copy:** agents speak in plain first-person status lines ("Adding empty state to Upcoming"), never personality or emoji. Costs and models are stated plainly ("Claude Opus 5.5 · your key · $0.04").

## Iconography

- Drawpane uses its own 65-glyph set (`assets/Icons`, also `Drawpane.Icon`): a 16px grid, 1.5px stroke, round caps and joins, outline style. Only the component and opacity glyphs use a fill.
- In code, icons inherit `currentColor`. The SVG files are single-ink in `#1c1b19` (Paper `ink`) for docs and slides.
- Never mix in another icon family or use emoji as icons. New glyphs go on the same grid and are added to the set.

## Logo

- The mark is two panes: an outlined pane behind, a solid signal pane in front, offset by a third. Use `drawpane-mark.svg` on light grounds, `drawpane-mark-graphite.svg` on dark grounds, `drawpane-mark-mono.svg` where only one ink is possible, and `drawpane-app-icon.svg` for the PWA and favicon.
- Keep clear space of half the mark's width on every side. The minimum size is 16px.
- The wordmark is "Drawpane" set in Instrument Sans 600 at −1% tracking, to the right of the mark, with a gap of 0.4 × the mark's height. An outlined wordmark file has not been produced yet.

## Accessibility

- Every text and ground pair named in a token's usage note meets WCAG 2.2 AA in both themes. Control borders, focus rings and meaningful icons meet 3:1.
- Color is never the only signal: status Badges carry icons and words, and hidden layers show the eye-off glyph as well as dimming.
- Every IconButton has a `label`. Trees, menus, radio groups and switches use their ARIA roles (see each component's guidelines).

## Using this system

Components are in `components/bundle.js` as `window.Drawpane` and need React 18 on the page. Load `tokens.css`, then `components/bundle.css`, which imports the three Google Fonts. Class names are prefixed `dp-`. `Drawpane.icons` lists every icon name.
