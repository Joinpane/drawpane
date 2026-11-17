# 0034. Variables, modes and styles, compatible with Figma's

- Status: proposed
- Date: 2026-11-18
- Deciders: Ziyang (lead maintainer)

## Context

Someone imported a 500k-layer commercial UI kit (decisions 0027 and 0030) and found that none of its variables or styles came in. In Figma the kit is built on them: its shadows are effect styles whose every field (x, y, blur, spread, colour) is bound to a variable; those variables alias variables in other collections, a colour composed at an opacity; and a frame picks the kit's visual style by setting a mode. In Drawpane the shadows came out as zeros: the import baked each layer's values as Figma saved them for the component's own default mode, and a copy placed in a frame set to another mode kept them.

What the kit's records hold, decoded from its `.fig` (counts only; the file's content stays out of the repo):

| | |
| --- | --- |
| Collections | 8 (6 with variables of their own; 2 are copies of library collections, empty), 1 to 8 modes each |
| Variables | 2,465 (62 soft-deleted): 1,317 numbers, 1,124 colours, 14 strings, 10 booleans |
| Variable values | 11,198 aliases (within and across collections), 904 colours composed at an opacity (`COMPOSE_COLOR`), 2,800 numbers, 611 colours, 94 strings and booleans |
| Metadata | scopes on every variable (17 kinds used), web code syntax on 834, descriptions, hidden-from-publishing flags; 2 collections marked extendable |
| Styles | 393 text, 63 effect, 2 fill (24 soft-deleted); 11,797 layers link a text style, 3,369 an effect style |
| Bindings on layers | about 295,000, before copies are filled in. The most used: auto layout gaps and padding (20,226 and 13,665 each side), each corner's radius (13,350 each), sizes and min/max sizes (27,315 in all), stroke weights by side (20,444 in all), typography (5,700), opacity (732), visibility in overrides (104,453, through expressions) |
| Bindings in paints and effects | 62,612 solid paint colours, 87 gradients' stops, 1,291 shadow colours, 1,227 spreads, 1,096 blurs and y offsets, 410 x offsets, 24 blur radii |
| Explicit modes | 172 frames and instances set one |
| Expressions | `IS_TRUTHY` 2,629 (visibility), `STRINGIFY` 27, `MULTIPLY` a handful |

What Drawpane has today:

- **Model** (`schema.ts`): `collection` nodes with `modes` (at most 16), `variable` nodes with `variableType` (colour, number, string), `values` per mode (a literal or `{ alias }`) and `description`; `textStyle` nodes; on layers, `bindings` from 16 keys (`fill` and `stroke` meaning the first solid paint) to a variable, and `variableModes` on frames and pages.
- **Resolution is materialized** (`editor/src/variables.ts`): a bound property holds its resolved value, written by the client that changed the variable, the mode or the binding, in the same transaction. Text styles work the same way (`text-styles.ts`). Finding what a variable drives scans every node.
- **Import** brings no variables or styles. Open Pencil resolves a copy's bound fills and numbers in the modes around it (decision 0025, PR #170), and the converter bakes them. Effects, styles and most fields aren't resolved; expressions it can't follow are dropped.
- **UI**: a Tokens workspace (`apps/web/src/editor/tokens/`, designs `Tokens.dc.html`, `TokenModes.dc.html`, `TokenExport.dc.html`) and a token picker on a few inspector fields; CSS and DTCG export of what the model holds.

Materialized values don't survive compact copies (decision 0029) or real kits:

- A copy in a frame set to another mode resolves differently from its main, so every bound value of every such copy would be stored in its override record, and rewritten in all of them when a variable changes. The kit's one theme switch would write into tens of thousands of records.
- Editing a variable bound by 60,000 paints writes 60,000 operations, synced, undone and stored.
- Switching a page's mode rewrites every bound layer on it.

## Decision

**Store what's bound; present what it resolves to.** Variables, modes and styles are nodes, bindings name them, and the editor's document resolves bound values where they're read, as it builds copies (decision 0029). The renderer, layout, hit testing, export, the inspector and the agent tools read resolved values and need nothing new. Nothing writes a resolved value back when a variable or a mode changes, and what a change affects is found through indexes, never by scanning the file.

### 1. Collections, modes and variables

- **Collections** (`collection`, under the root or a library node) keep `name`, `modes` and `description`, and gain `hiddenFromPublishing`. The first mode is the default (an import puts Figma's default mode first, as Figma lists it). Modes go up to 64 per collection, past Figma's largest plan, so no file Figma can save is refused.
- **Variables** (`variable`, under their collection) have a `variableType` of `color`, `number`, `string` or `boolean`, and `values` by mode id. A value is a literal of the variable's type, or an alias: `{ alias: <variable id> }`, optionally with `opacity` (0 to 1), the colour composed at that opacity, which is what Figma's `COMPOSE_COLOR` does. An alias may name a variable in any collection of the file (or a library copy, section 6).
- **Metadata**: `description`; `scopes`, Figma's names (`ALL_SCOPES`, `CORNER_RADIUS`, `WIDTH_HEIGHT`, `GAP`, `ALL_FILLS`, `FRAME_FILL`, `SHAPE_FILL`, `TEXT_FILL`, `STROKE_COLOR`, `STROKE_FLOAT`, `EFFECT_FLOAT`, `EFFECT_COLOR`, `OPACITY`, `FONT_FAMILY`, `FONT_STYLE`, `FONT_WEIGHT`, `FONT_SIZE`, `LINE_HEIGHT`, `LETTER_SPACING`, `PARAGRAPH_SPACING`, `PARAGRAPH_INDENT`, `TEXT_CONTENT`, `FONT_VARIATIONS`, `TRANSFORM`), which the binding pickers filter by and nothing else enforces, as in Figma; `codeSyntax` for `web`, `ios` and `android`; `hiddenFromPublishing`.
- **Groups are names.** A variable named `color/light/custom/ring` sits in the groups `color`, `color/light` and `color/light/custom`, as in Figma. Group operations (rename, move to another group, ungroup, duplicate, delete) are edits to the names of the variables in the group, in one transaction. A collection's order is its variables' order keys.
- **Extended collections** (Figma's: a collection that extends another, usually a library's, keeping its variables and overriding some values): a collection with `extends` naming its parent; each of its modes names the parent mode it extends (`parent` on the mode); its children are `variable` nodes with `overrides` naming the parent's variable, holding `values` only for the modes they change. A frame that sets a mode of the extension resolves the parent's variables through it (section 4). Variables of its own and modes beyond the parent's follow Figma: allowed where Figma allows them, and the importer keeps what it finds.
- **Expressions.** A value or a binding may be an expression where Figma has one: `{ expr: "truthy" | "stringify" | "multiply" | "add" | ..., args: [...] }`, args being literals or aliases. Phase 5 evaluates them; until then the importer keeps the value Figma saved (as now) and notes it.

### 2. Bindings: every field Figma binds

A binding names a variable by id. Bindings live with what they bind, so they move with it: a paint's binding stays with the paint when paints are reordered, which a binding by index wouldn't.

- **Layers' own properties**: `bindings`, from a key to a variable, on layers and text styles.

  | Key | Drives | Figma's field (REST `boundVariables`; `.fig` `variableField`) | Type |
  | --- | --- | --- | --- |
  | `width`, `height` | `width`, `height` | `width`, `height`; `WIDTH`, `HEIGHT` | number |
  | `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | the same | `minWidth`...; `MIN_WIDTH`... | number |
  | `gap` | `gap` | `itemSpacing`, `gridColumnGap`; `STACK_SPACING`, `GRID_COLUMN_GAP` | number |
  | `rowGap` | `rowGap` | `counterAxisSpacing`, `gridRowGap`; `STACK_COUNTER_SPACING`, `GRID_ROW_GAP` | number |
  | `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft` | the same | `paddingTop`...; `STACK_PADDING_TOP`... | number |
  | `cornerRadius` | `cornerRadius` | `CORNER_RADIUS` | number |
  | `topLeftRadius`, `topRightRadius`, `bottomRightRadius`, `bottomLeftRadius` | that corner of `cornerRadii` | `topLeftRadius`...; `RECTANGLE_TOP_LEFT_CORNER_RADIUS`... | number |
  | `strokeWeight` | `strokeWeight` | `strokeWeight`; `STROKE_WEIGHT` | number |
  | `strokeTopWeight`, `strokeRightWeight`, `strokeBottomWeight`, `strokeLeftWeight` | that side of `strokeWeights` | `strokeTopWeight`...; `BORDER_TOP_WEIGHT`... | number |
  | `opacity` | `opacity` | `opacity`; `OPACITY` (a percentage, as in Figma) | number |
  | `visible` | `visible` | `visible`; `VISIBLE` | boolean |
  | `characters` | `characters` | `characters`; `TEXT_DATA` (a number or boolean shows as Figma writes it) | string |
  | `fontFamily` | `fontFamily` | `fontFamily`; `FONT_FAMILY` | string |
  | `fontStyle` | `fontWeight` and `fontStyle` | `fontStyle`; `FONT_STYLE` ("Semi Bold Italic") | string |
  | `fontWeight` | `fontWeight` | `fontWeight` | number |
  | `fontSize` | `fontSize` | `fontSize`; `FONT_SIZE` | number |
  | `lineHeight` | `lineHeight`, in px | `lineHeight`; `LINE_HEIGHT` | number |
  | `letterSpacing` | `letterSpacing`, in px | `letterSpacing`; `LETTER_SPACING` | number |
  | `paragraphSpacing` | `paragraphSpacing` | `paragraphSpacing`; `PARAGRAPH_SPACING` | number |

  The old keys `fill` and `stroke` (the first solid paint) are still read, and become paint bindings when a file is migrated (section 12).
- **Paints** (fills and strokes, on layers and in paint styles): `bind: { color, opacity }` on the paint, and `bind: { color }` on each gradient stop. A bound colour gives the paint its colour and its alpha, replacing the paint's opacity: Figma saves the variable's alpha as the paint's opacity, so applying both would count it twice (measured on the kit: translucent overlays and invalid fills came out nearly clear). A bound paint opacity is Drawpane's (Figma binds colours only), a percentage like layer opacity.
- **Effects** (on layers and in effect styles): shadows `bind: { x, y, blur, spread, color, visible }`, blurs `bind: { radius, visible }`. Figma's are `offsetX`, `offsetY`, `radius`, `spread` and `color` (REST), `xVar`, `yVar`, `radiusVar`, `spreadVar` and `colorVar` (`.fig`).
- **Text runs** carry `bindings` with the typography keys, for styled ranges, as Figma's style overrides do.
- **Layout grids** (on frames and in grid styles): `bind: { count, gutter, offset, size }` on a grid.

A binding of the wrong type, or to a variable that doesn't resolve, is ignored: the stored value shows.

### 3. Styles

- **Four kinds, nodes beside pages**, as `textStyle` is: `paintStyle` (`fills`, a list of paints, as Figma's colour styles are), `effectStyle` (`effects`), `gridStyle` (`layoutGrids`) and `textStyle` (typography, as now). Each has `name` (with groups by `/`), `description` and `hiddenFromPublishing`. Their paints, effects, grids and typography may be bound to variables, so a style built from variables is just a style with bindings.
- **Layers link styles by reference**: `fillStyle` and `strokeStyle` (a paint style each), `effectStyle`, `gridStyle`, and `textStyle` (as now). While a link holds, the layer shows the style's value, resolved where the layer is (an effect style bound to variables casts different shadows in different modes). Text runs link text and fill styles too.
- **Editing the linked property by hand detaches the link** and keeps what it showed, as text styles do now and as Figma does. Applying a style sets the link and stores its current values as the layer's own.
- **Detaching a style** (a menu item) stores its values on the layer and drops the link.
- Text styles become presented like the rest (section 4) instead of written into every layer that follows them (`textStyleFixupOps`), so editing a style used 10,000 times is one operation.

### 4. Resolution: in the view, incremental

- **Where.** `@drawpane/model` gets a resolver: given a node as presented (a copy built by 0029's view included) and a way to read its ancestors, variables and styles, it returns the node with its bound values resolved, or the same object when it binds nothing. The editor's `Doc` wraps its reads with it (`get`, `nodes`, `ancestors`); server paths that read layers use the same function, as they build copies with the model's (decision 0029, point 6).
- **Modes.** A variable of collection C resolves, at a layer, in the mode set by the nearest of the layer, its frames, its instance roots and its page (`variableModes`), else C's default mode. An alias into collection D resolves in D's mode at the same layer. A mode set to an extension of C resolves C's variables through the extension's overrides, else its parent mode. A mode that no longer exists is skipped.
- **Values.** Aliases are followed to a depth of 16; a cycle, a missing variable or a value of the wrong type resolves to nothing, and the stored value shows. A missing value in a mode falls back to the default mode's. Colours become `#rrggbbaa`; an alias's `opacity` multiplies the alpha.
- **The stored value is a fallback, not a cache.** The import stores what Figma saved, binding stores what the variable gave at that moment, and nothing keeps it up to date afterwards. It's what a reader sees without the resolver (an older client, a version snapshot read raw) and what shows when a binding can't resolve.
- **Copies.** A copy layer presents its main's bindings like any other property, so it resolves in its own place: a button copied into a frame set to another mode casts that mode's shadow, with nothing stored for it. A copy that overrides a bound property stores its value and drops the binding in its override record. Setting a mode on an instance is `variableModes` on its root.
- **Layout and text measurement stay stored** (decision 0029, point 4). They read resolved values. A change that alters what they read (a number variable, a mode switch, a font size) is laid out by the client that made it, in the same transaction, and the layout is stored as any other; other clients only redraw. A layout-neutral change (a colour, an effect) lays out nothing.
- **What a change affects**, from indexes kept as the document changes, never a scan:
  - variable → the nodes and styles that bind it, directly or in their paints and effects;
  - variable → the variables that alias it (so an edit reaches everything resolving through it);
  - style → the layers that link it;
  - a copy layer is reached from the main layer it's built from (the view's own index), so only copies that were built are dropped.

  So editing a variable costs what is bound to it and to its aliases; switching a frame's mode costs the bound layers under that frame; editing a style costs its users. The resolved nodes they name are dropped from the cache and named in the document's change, which the renderer's index and the scene's caches already follow (decisions 0028, 0029).

### 5. Editing

- Setting a bound property by hand removes its binding (as now); for paints, effects, stops and grids, only the field that changed loses its binding.
- Binding a field stores the variable's current value with the binding, in one operation.
- Deleting a variable leaves its bindings in place, resolving to nothing, so layers keep their stored value; undoing the delete brings everything back. The variables table offers to detach or rebind what used it.
- Changing a variable's type, or deleting a mode, keeps values where they're still valid and refuses nothing a collaborator could be relying on: what doesn't fit stops resolving.

### 6. Libraries

- Publishing (decision 0010) includes variables and styles on their own, not only as dependencies of components: the manifest lists collections, variables and styles with content hashes. A file that uses the library binds to its variables and links its styles through copies under the library node, ids derived from the library file and the original id, read-only, updated with the rest through **Review updates**.
- A file can set modes of a library's collection on its frames, and extend a library's collection (section 1).

### 7. Import

- **One converter.** The REST-shaped file (decisions 0014 and 0025) gains what Figma's REST API returns for variables and styles: `variables`, shaped as `GET /v1/files/:key/variables/local` returns them (collections with modes and default mode, variables with type, values by mode, aliases, scopes, code syntax, descriptions, hidden flags), styles' definitions by style id (what `GET /v1/files/:key/nodes` returns for a style's node), `styles` on each node (its links), `boundVariables` on nodes, paints, gradient stops and effects, and `explicitVariableModes` on frames and instances. `@drawpane/figma` converts that into collections, variables, styles, links, bindings and modes.
- **From `.fig`:** variables and collections from Open Pencil's graph (which reads records' metadata), soft-deleted ones skipped; styles from the records Figma keeps them in (the internal page), adapted like layers; bindings from Open Pencil's per-layer `boundVariables` (which apply instance overrides) and, for effects and gradient stops, which Open Pencil doesn't keep, from the records' `xVar`, `yVar`, `radiusVar`, `spreadVar`, `colorVar` and `stopsVar`.
- **From a link:** the variables endpoint needs the `file_variables:read` scope, and Figma serves it only to members of Enterprise organisations. The Import dialog asks for the scope; without it (or off Enterprise), the file comes in as now, values baked, with a note that its variables need the `.fig`. Style definitions come from the nodes endpoint, one read for all of them.
- **Ids.** A variable is `drawpaneId("VariableID:<guid>")`, a collection `drawpaneId("VariableCollectionId:<guid>")`, a mode `drawpaneId(<mode guid>)` and a style its node's id, the same however the file is read (REST's ids are these strings), so importing again matches them up. A library variable known only by key gets an id derived from its key.
- **Values Figma saved are kept** as the stored fallback, so a binding that can't be followed (a library the file doesn't carry, an expression not yet evaluated) shows what Figma showed.

### 8. Export

- **DTCG** (W3C Design Tokens): every collection as a group, variables by their groups, `$type` (`color`, `dimension` or `number` by scope, `string`, `boolean`), `$value` in the default mode, aliases as `{group.token}`, descriptions, the other modes under `$extensions` (or one file per mode, as Figma's own variables export writes them, so Figma can import them back), scopes, code syntax and hidden flags beside them; styles as `shadow`, `typography`, `color` and `gradient` composites whose fields are aliases where bound. Importing a DTCG file creates or updates variables by name.
- **CSS**: each collection's default mode on `:root`, every other mode under `[data-<collection>="<mode>"]`, aliases as `var()`, colours composed at an opacity with `color-mix()`, a variable's web code syntax used as its name when it has one. Styles become utility classes (`box-shadow`, `font`, `background`).

### 9. Editor UI

- **Variables table** (Figma's): collections in a sidebar with counts; a groups tree for the collection, "All" first; rows of variables under their group headers with a type icon, a column per mode (adding, renaming, reordering and deleting modes from the header), values edited in place (colour swatch with hex and opacity, number, text, a switch), aliases shown as chips that open the picker, a search, a filter by type and scope, and a details panel for description, scopes, code syntax and publishing. Virtualized, so 2,000 rows scroll at 60 frames a second.
- **Binding in the inspector**: every field in section 2's table has the bind affordance (hover, or the field's menu): a picker of the variables of the right type whose scopes allow that field, grouped as the table is, with search. A bound field shows the variable's name as a chip and its resolved value on hover; detach from the chip's menu. Paints, stops and effects have it per field.
- **Styles**: a picker for paint, text, effect and grid styles beside each section (Figma's "4 dots"), listing styles by group with previews; a linked section shows the style's name with detach and edit.
- **Modes**: the frame, instance and page sections show "Variable modes" with a picker per collection that has more than one mode ("Auto" inherits), and the layers panel tags frames that set one (as now).
- The designs `Tokens.dc.html` and `TokenModes.dc.html` are redrawn to these before phase 3 builds them, with a new `VariableBinding.dc.html` for the inspector and `StylePicker.dc.html`.

### 10. Sync, undo, branches and merge

Variables, collections, styles, bindings, links and modes are node properties, so operations, undo, history, branches (decision 0012) and merging need nothing new. Two people editing different modes of one variable at the same moment edit the same property (`values`), and the later write wins; values are small, and the table writes one variable per edit. A merge conflicts per variable, as per layer property.

### 11. Agent tools

The MCP server and the agent runner (decisions 0011, 0021, 0033) gain: list collections, variables (filtered by group, type, scope) and styles; create, rename, retype, regroup and delete them; set values per mode, aliases included; bind and unbind any field of section 2 (paints, stops and effects by index); link and detach styles; set a frame's mode; export DTCG and CSS. Reads of layers include their bindings and links next to the resolved values.

### 12. Migration

Every change is additive: files from before load as they are. The resolver reads the old `fill` and `stroke` keys, and stored values become the fallback they already equal. When a room next loads a file, a one-step migration moves `fill` and `stroke` bindings into paint bindings, and turns text styles' copied values into fallbacks (nothing to rewrite: they already are). A number variable bound to opacity holding a fraction (Drawpane's older reading took values of 1 or less as fractions) is multiplied by 100 at the same time, so it reads as a percentage, as Figma's do. Tabs from before the release are told to reload at hello (the protocol version goes up), so none of them strips bindings it doesn't know from a paint it rewrites.

## Phases

| Phase | What | Done when |
| --- | --- | --- |
| 1 | **Import and live resolution.** The model: boolean variables, composed aliases, metadata, 64 modes, paint, stop and effect bindings, every layer binding key, paint and effect styles and links. The resolver in the model and in the editor's `Doc`, with the indexes. `.fig` import of every variable, collection, paint, effect and text style, with bindings, links and explicit modes. Changing a variable or a mode redraws what it affects, through the Tokens workspace as it is. | The kit's shadows and themed copies draw as Figma's (kit parity run against the baseline); kit-free tests of import and resolution; a variable edit and a mode switch touch only what's bound |
| 2 | **Everywhere a file is read.** The resolver in the server's readers (MCP reads, thumbnails, SVG and code export through the model); text styles presented, not written; the migration and the protocol bump; DTCG and CSS export as section 8; DTCG import; variables by link through the REST endpoint where the token allows. | Exports of the kit's themed frames match the canvas |
| 3 | **Editing UI.** Designs first, then the variables table, binding on every field, style pickers, mode pickers on frames, instances and pages, grid styles. | The flows of section 9, e2e-tested |
| 4 | **Libraries.** Publishing variables and styles on their own; binding to a library's; extended collections; review updates for them. | A kit file publishes its tokens and another file themes with them |
| 5 | **Expressions, text runs, agents.** `IS_TRUTHY`, `STRINGIFY`, arithmetic and conditionals evaluated; bindings and style links on text runs; the agent tools of section 11. | The kit's 2,629 visibility expressions come in live |

## Consequences

- A bound value is decided where it's read, so copies stay compact in any mode, and a variable edit, a mode switch or a style edit costs what it reaches, not the file.
- Every reader of layers goes through the resolver or sees fallback values; phase 2 closes the server's paths. Until then, server-side renders of themed copies show the values Figma saved (as today).
- Resolution adds work to reads of bound layers. It's cached per node and dropped only when an index says so; a layer that binds nothing costs one check.
- The file carries both bindings and fallback values: about 30 bytes per bound paint or effect field (a few MB on the kit).
- Figma features without a counterpart yet: variables bound to prototype interactions and conditional logic (phase 5 covers the expressions, not prototyping), `TRANSFORM` scoped variables (x, y, rotation: bindable later on the same model), and variable fonts' axes.
