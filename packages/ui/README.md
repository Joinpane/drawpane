# @drawpane/ui

The Drawpane design system in React 19 and TypeScript: tokens, self-hosted fonts, 86 icons, the logo and 23 components. It is a production port of [`design-system/`](../../design-system/README.md), which stays the spec and the single source for tokens and icons.

## Use it

```tsx
import "@drawpane/ui/styles.css";
import { Button, CommandBar, NumberField } from "@drawpane/ui";

export function App() {
  return (
    <div className="dp-root">
      <Button variant="primary">Publish library</Button>
    </div>
  );
}
```

- **Import `@drawpane/ui/styles.css` once**, at the app root. It brings the fonts, tokens, a small base layer and every component's styles. Class names are prefixed `dp-`.
- **Wrap the app in `.dp-root`.** It sets the UI font, 12px/16px body text and `ink`. Nothing is applied to `body` or to bare elements, so the package can live next to other CSS.
- **Theme with `data-theme`.** Paper (light) is the default on `:root`. Set `data-theme="dark"` on `<html>` (or any subtree) for Graphite. Components bind tokens and never branch on theme.
- **Fonts are self-hosted** through Fontsource (Instrument Sans Variable, Instrument Serif, JetBrains Mono Variable). No request goes to Google Fonts. `--font-ui`, `--font-display` and `--font-mono` name the self-hosted families first.
- **Motion** uses `--duration-hover` (90 ms), `--duration-toggle` (120 ms) and `--duration-popover` (160 ms). They drop to `0s` under `prefers-reduced-motion` and while a NumberField is being scrubbed.
- **Focus** is the `--shadow-focus` ring on `:focus-visible` everywhere, except Inspector fields, which turn their border `signal` as the brand book specifies.

The package ships as TypeScript source (`exports` points at `src/`), so the app's bundler (Vite) compiles it.

### Exports

| Export | What |
| --- | --- |
| Components | `Icon`, `Button`, `IconButton`, `Kbd`, `Tooltip`, `Badge`, `TextField`, `NumberField`, `TokenChip`, `SegmentedControl`, `Switch`, `PropertySection` (+ `PropertyRow`), `LayerRow`, `Menu`, `ContextMenu` (+ `placeMenu`), `Popover` (+ `placePopover`), `ColorPicker`, `CommandBar`, `SelectionLens`, `PresenceStack`, `AgentTag`, `AgentStep` (+ `AgentPlan`), `PromptField`, `Logo` |
| Icons | `iconData`, `iconNames`, `type IconName` (all 86 glyphs, in the design system's order) |
| Tokens | `colors`, `shadows`, `space`, `radii`, `sizes`, `fontFamilies`, `typeStyles`, their name types (`ColorToken`, `SpaceToken`, …), `cssVar(token)`, `presenceSlot(n)`, `presenceColor(n)` |
| Helpers | `cx(...classes)`, `evaluateNumericInput(text, options)` (the math and units parser NumberField uses, for the command bar too), `formatNumber`, `roundTo`, color math for pickers (`parseColor`, `parseHex`, `toHex`, `rgbToHsv`, `hsvToRgb`, `rgbToHsl`, `hslToRgb`, `contrastRatio`, `contrastLevel`) |

Typography is available as `font` shorthands (`font: var(--type-ui-body)`) and as classes (`.dp-text-ui-body`, `.dp-text-display-md`, …).

## Tokens and icons are generated

`src/styles/tokens.css`, `src/tokens.ts` and `src/icons.ts` are generated from `design-system/tokens.json`, `design-system/assets/Icons/*.svg` and the icon order in `design-system/design-system.json`. Don't edit them by hand. Change the design system, then run:

```sh
pnpm --filter @drawpane/ui tokens           # regenerate
node packages/ui/scripts/build-tokens.ts --check   # fail if out of date
```

The script is plain Node (built-in type stripping, no build step). Its output is already in Biome's format, and `test/tokens.test.ts` fails when a generated file is stale.

## Gallery

```sh
pnpm --filter @drawpane/ui dev
```

Serves `gallery/` with Vite: every component card from `design-system/index.html`, rebuilt with this package, with the same groups, sizes and sample content, next to each component's guidelines. The "Graphite theme" button toggles `data-theme="dark"` on `<html>`; `?theme=dark` opens it in Graphite.

## Tests

```sh
pnpm --filter @drawpane/ui test        # Vitest + jsdom + Testing Library
pnpm --filter @drawpane/ui typecheck   # tsc -p .
```

The tests cover keyboard and ARIA behavior (Menu, SegmentedControl, Switch, NumberField, CommandBar, Tooltip, LayerRow, PromptField), a render test for every component, the numeric parser, generated-file freshness and a check that no stylesheet has a raw color.

## Differences from the reference bundle

The props follow `design-system/components/index.d.ts`. Where they had to change for real behavior:

- **NumberField** `value` and `defaultValue` are numbers, and `null` means "Mixed". `onChange(value: number)` fires on commit (Enter, blur, arrows, each scrub step), not on every keystroke. Added `min`, `max`, `step`, `precision`, `units`, `onScrubStart`, `onScrubEnd`, `onTokenClick`. `className` goes on the field wrapper and the other props on the input.
- **SegmentedControl** is generic over its values, can be uncontrolled (`defaultValue`), and options take `disabled`.
- **Switch** adds `defaultChecked`; it passes other button props through.
- **Menu** `MenuItem` is a union of action items, `{ separator: true }` and `{ heading }`. Added `onSelect`, `onClose(reason)`, `autoFocus` and per-item `onSelect` and `id`. `active` sets the initially focused item; after that, keyboard focus is the active item.
- **CommandBar** `query` is controlled with `onQueryChange` (or uncontrolled with `defaultQuery`). Added `onRun`, `onComplete` (Tab), `onClose` (Escape), `autoFocus`, `emptyLabel`. The host filters `groups`; empty groups are hidden.
- **Tooltip** with `children` wraps a trigger and handles hover, focus, Escape and `aria-describedby`. Without children it renders only the bubble, as before. Added `placement`, `delay`, `describe` and `disabled`.
- **IconButton** shows its label and shortcut in a Tooltip instead of a native `title` (opt out with `tooltip={false}`).
- **LayerRow** accepts div props and adds `onToggleExpanded`, `onToggleHidden`, `onToggleLocked`, `onRename` (double-click or F2) and `presenceLabel`. The tree owns roving focus: pass `tabIndex={0}` to the focused row.
- **AgentStep** renders an `<li>`; put steps in the new `AgentPlan` (`<ol>`).
- **PromptField** `value` is controlled (`onValueChange`) or uncontrolled (`defaultValue`). Added `onSubmit`, `onStop`, `onAttach`, `onSkills`, `onTrigger("/" | "@")` and `textareaRef`. Send is disabled while the field is empty.
- **PresenceStack** adds `onFollow` and `following`; `Person` takes an optional `id`.
- **TokenChip** truncates from the left (`…/brand/500`), as its guidelines ask, and becomes a button when given `onClick`.
- The token type classes are `.dp-text-<style>` rather than the bare `.ui-body` and `.kbd` of `tokens.css`, so they can't collide with app classes or the Kbd component.
