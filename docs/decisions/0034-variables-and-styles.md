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
  | `topLeftRadius`, `topRightRadius`, `bottomRightRadius`, `bottomLeftRadius` | that corner of `cornerRadii` | `topLeftRadius`...; `RECTANGLE_TOP_LEFT_CORNER_RADIUS`... (brought only where the corners are independent: otherwise Figma draws the uniform radius and these don't change it) | number |
  | `strokeWeight` | `strokeWeight` | `strokeWeight`; `STROKE_WEIGHT` | number |
  | `strokeTopWeight`, `strokeRightWeight`, `strokeBottomWeight`, `strokeLeftWeight` | that side of `strokeWeights` | `strokeTopWeight`...; `BORDER_TOP_WEIGHT`... | number |
  | `opacity` | `opacity` | `opacity`; `OPACITY` (a percentage, as in Figma: the binding says `unit: "percent"`) | number |
  | `visible` | `visible` | `visible`; `VISIBLE` | boolean |
  | `characters` | `characters` | `characters`; `TEXT_DATA` (a number or boolean shows as Figma writes it: the binding says `unit: "text"`) | string |
  | `fontFamily` | `fontFamily` | `fontFamily`; `FONT_FAMILY` | string |
  | `fontStyle` | `fontWeight` and `fontStyle` | `fontStyle`; `FONT_STYLE` ("Semi Bold Italic") | string |
  | `fontWeight` | `fontWeight` | `fontWeight` | number |
  | `fontSize` | `fontSize` | `fontSize`; `FONT_SIZE` | number |
  | `lineHeight` | `lineHeight`, in the layer's unit (a percentage of the font size when the layer's is one, else px) | `lineHeight`; `LINE_HEIGHT` | number |
  | `letterSpacing` | `letterSpacing`, in the layer's unit (px or a percentage of the font size) | `letterSpacing`; `LETTER_SPACING` | number |
  | `paragraphSpacing` | `paragraphSpacing` | `paragraphSpacing`; `PARAGRAPH_SPACING` | number |

  A binding is the variable's id, or, where this decision reads a value differently from before, the id with the unit its value is read in: `{ variable, unit: "percent" }` for `opacity` and `{ variable, unit: "text" }` for `characters` (section 12). The old keys `fill` and `stroke` (the first solid paint) are still read, as before.

  Line height and letter spacing take their unit from the layer, as Figma does: a variable worth 5 bound to a letter spacing set in percent is 5% of the font size, and in pixels 5 px. Neither was bindable before this decision, so no stored binding read them otherwise and the binding needs no unit of its own; the unit is the layer's value's, which a copy's override can set. From a `.fig`, the importer reads that unit from the record or the copy's override, since Open Pencil 0.16 keeps pixels only and applies a bound value as pixels whatever the unit.
- **Paints** (fills and strokes, on layers and in paint styles): `bind: { color, opacity }` on the paint, and `bind: { color }` on each gradient stop. A bound colour gives the paint its colour and its alpha. The paint's own `opacity` is independent: a multiplier a person sets, applied on top of the variable's alpha, never replaced by it. A bound paint opacity is Drawpane's (Figma binds colours only), a percentage like layer opacity.
- **Alpha is normalised once, at import.** Figma saves a bound colour's alpha twice: in the variable and again as the paint's opacity. Applying both counts it twice (measured on the kit: translucent overlays and invalid fills came out nearly clear); stripping the paint's opacity on every read would throw away a person's later edit. So the importer folds the saved opacity into the stored colour (`#rrggbbaa`, the fallback) and the paint keeps no opacity of its own. A composed alias's `opacity` still multiplies the alpha once, in the resolver.
- **Effects** (on layers and in effect styles): shadows `bind: { x, y, blur, spread, color, visible }`, blurs `bind: { radius, visible }`. Figma's are `offsetX`, `offsetY`, `radius`, `spread` and `color` (REST), `xVar`, `yVar`, `radiusVar`, `spreadVar` and `colorVar` (`.fig`).
- **Text styles** carry `bindings` with the typography keys only (`fontFamily`, `fontStyle`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`); the model refuses any other key on a `textStyle`. They're stored from phase 1, so the reference is never lost at import, and presented from phase 2 (section 3).
- **Text runs** carry `bindings` with the typography keys, for styled ranges, as Figma's style overrides do.
- **Layout grids** (on frames and in grid styles): `bind: { count, gutter, offset, size }` on a grid.

A binding of the wrong type, or to a variable that doesn't resolve, is ignored: the stored value shows.

### 3. Styles

- **Four kinds, nodes beside pages**, as `textStyle` is: `paintStyle` (`fills`, a list of paints, as Figma's colour styles are), `effectStyle` (`effects`), `gridStyle` (`layoutGrids`) and `textStyle` (typography, as now). Each has `name` (with groups by `/`), `description` and `hiddenFromPublishing`. Their paints, effects, grids and typography may be bound to variables, so a style built from variables is just a style with bindings.
- **Layers link styles by reference**: `fillStyle` and `strokeStyle` (a paint style each), `effectStyle`, `gridStyle`, and `textStyle` (as now). While a link holds, the layer shows the style's value, resolved where the layer is (an effect style bound to variables casts different shadows in different modes). Text runs link text and fill styles too.
- **Editing the linked property by hand detaches the link, in the same transaction**, and keeps what it showed, as text styles do now and as Figma does: the list written is the style's, as shown, with the edit, its bindings kept where the edit didn't change them. Setting a list to exactly what it shows changes nothing and keeps the link. Applying a style sets the link and stores its current values as the layer's own.
- **Detaching a style** (a menu item) stores its values on the layer and drops the link.
- Text styles become presented like the rest (section 4) instead of written into every layer that follows them (`textStyleFixupOps`), so editing a style used 10,000 times is one operation.

### 4. Resolution: in the view, incremental

- **Where.** `@drawpane/model` gets a resolver: given a node as presented (a copy built by 0029's view included) and a way to read its ancestors, variables and styles, it returns the node with its bound values resolved, or the same object when it binds nothing. The editor's `Doc` wraps its reads with it (`get`, `nodes`, `ancestors`); server paths that read layers use the same function, as they build copies with the model's (decision 0029, point 6).
- **Modes.** A variable of collection C resolves, at a layer, in the mode set by the nearest of the layer, its frames, its instance roots and its page (`variableModes`), else C's default mode. An alias into collection D resolves in D's mode at the same layer. A mode set to an extension of C resolves C's variables through the extension's overrides, else its parent mode. A mode that no longer exists is skipped.
- **Values.** Aliases are followed to a depth of 16; a cycle, a missing variable or a value of the wrong type resolves to nothing, and the stored value shows. A missing value in a mode falls back to the first value stored, as before this decision. Colours become `#rrggbbaa`; an alias's `opacity` multiplies the alpha.
- **The stored value is a fallback, not a cache.** The import stores what Figma saved, binding stores what the variable gave at that moment, and nothing keeps it up to date afterwards. It's what shows when a binding can't resolve. It is not a read contract: no reader that computes from values (agents, exports, thumbnails) reads it raw (see "The resolved read boundary" below).
- **Each occurrence's saved value.** A copy whose value differs from its main's only where both bind the same variables (Figma saved each resolved in its own modes) isn't overriding it. The converter keeps the copy's saved value in its materialized output, not marked overridden. Converting to compact copies (decision 0029) doesn't store such a difference in the override record, since a stored value there would pin the copy against later edits to its main; the copy follows its main and resolves where it is. The conversion's own check treats those values as equal.
- **Copies.** A copy layer presents its main's bindings like any other property, so it resolves in its own place: a button copied into a frame set to another mode casts that mode's shadow, with nothing stored for it. A copy that overrides a bound property stores its value and drops the binding in its override record. Setting a mode on an instance is `variableModes` on its root.
- **Layout and text measurement stay stored** (decision 0029, point 4). They read resolved values. A change that alters what they read (a number variable, a mode switch, a font size) is laid out by the client that made it, in the same transaction, and the layout is stored as any other; other clients only redraw. A layout-neutral change (a colour, an effect) lays out nothing.
- **What a change affects**, from indexes kept as the document changes, never a scan:
  - variable → the nodes and styles that bind it, directly or in their paints and effects;
  - variable → the variables that alias it (so an edit reaches everything resolving through it);
  - style → the layers that link it;
  - a copy layer is reached from the main layer it's built from (the view's own index), so only copies that were built are dropped.

  So editing a variable costs what is bound to it and to its aliases; switching a frame's mode costs the bound layers under that frame; editing a style costs its users. The resolved nodes they name are dropped from the cache and named in the document's change, which the renderer's index and the scene's caches already follow (decisions 0028, 0029).
- **The invalidation contract.** What a change drops is worked out from the stored operations and their inverse, not from the operations as a person made them, so a change made here, the same change replayed from the room, its rollback (its stored inverse) and a rebase all reach the same layers:
  - a `variableModes` set on any stored node, an override record created, set or deleted that sets or unsets `variableModes`, and a move each name a changed scope, with the collections whose modes may differ (a set's old and new keys; every collection for a move or an `unset`);
  - each changed node stands for every built copy of it (instance roots of a changed main, copies of copies, the presented layer an override record belongs to);
  - under each, only layers bound to a variable of those collections are dropped (directly, through an alias, or through a linked style), and a frame that sets its own mode for all of them shields what's under it;
  - the walk is bounded: the built layers under the scope, while they're fewer than the bound layers of those collections, else those bound layers, each checked by its ancestors. A mode set on a frame of unbound layers, or a move of an unbound subtree, walks nothing when the file binds nothing to those collections. Nothing builds a copy to find out;
  - layout is queued only for layers whose layout reads what changed: a layout binding (section 2's number keys, visibility, typography) to a changed variable, or to a variable of a changed collection. A colour, an effect or a style change queues none.

  Tests compare a warm document after stored operations with one built fresh from the same stored form, for replay, inverse and copies of copies.
- **Memory.** On the server, the room's headless editor (decision 0033) holds a document bounded by a `BuildBudget` meter. The resolver's indexes are charged to the same meter as they're built (past its limit the build is refused, as a store's is) and given back when dropped; a resolved node is cached only while the meter has room for it, else it's resolved again when next read. The memory check holds token-heavy shapes (bound and styled layers, bound compact copies in two modes) to "the heap held is at most what the meter counts".
- **The resolved read boundary.** Every reader that computes from layer values reads them resolved where each layer is: the editor (`Doc`), the room's headless editor (agent tools), and the MCP server's reads (`get_node`, outlines, searches, through the model's resolver over the SQL reader, holding a few thousand nodes at most). An agent never computes from a value the canvas doesn't show. A snapshot can store unresolved state; whatever renders or calculates from it builds a resolver over that snapshot's own nodes, never live file state.

### 5. Editing

Every edit below is atomic: what it detaches, links or stores goes in the same transaction, one undo step.

- **A manual edit detaches** what it replaces: setting a bound property by hand removes its binding (as now), and setting a styled list removes its style link (section 3). For paints, effects, stops and grids, only the field that changed loses its binding.
- **Identity for reordering.** Items have no ids; an edit to a list is matched item by item before anything is detached: an item equal to one it was (reordered or kept) keeps its bindings; an item binding the same variables as an unmatched one it was is compared with that one (an edit, perhaps moved too), field by field; anything else is compared with the item at its index. So reordering paints, effects or gradient stops detaches nothing, and agents can reorder by index safely.
- **Binding captures.** Binding a field writes the binding with its unit where it has one (section 12), and stores what the field shows once bound (the variable's value where the layer is) as the fallback, in one operation: for a corner or a side, the whole `cornerRadii` or `strokeWeights`; for a font style, `fontWeight` and `fontStyle`.
- **Detaching materialises.** Detaching a binding by choice stores what every field it drove shows now, in the mode it's in, and drops the binding; for `fill` and `stroke` it detaches the paints' own bindings and a linked style too, keeping the paints as shown. Detaching a style (a menu item) stores its values on the layer and drops the link.
- Deleting a variable leaves its bindings in place, resolving to nothing, so layers keep their stored value (the historical fallback, possibly older than what was shown; a cycle resolves the same way); undoing the delete brings everything back. The variables table offers to detach or rebind what used it.
- Changing a variable's type, or deleting a mode, keeps values where they're still valid and refuses nothing a collaborator could be relying on: what doesn't fit stops resolving.

### 6. Libraries

- A component copied from a library brings the styles and collections it needs, and every reference is remapped to the copies' ids: `bindings`, what paints, stops, effects and text runs bind, the style links, aliases (their `opacity` kept whole) and the collections `variableModes` names. Nothing keeps naming the library's own ids, which could resolve to an unrelated node of the destination file.
- Publishing (decision 0010) includes variables and styles on their own, not only as dependencies of components: the manifest lists collections, variables and styles with content hashes. A file that uses the library binds to its variables and links its styles through copies under the library node, ids derived from the library file and the original id, read-only, updated with the rest through **Review updates**.
- A file can set modes of a library's collection on its frames, and extend a library's collection (section 1).

### 7. Import

- **One converter.** The REST-shaped file (decisions 0014 and 0025) gains what Figma's REST API returns for variables and styles: `variables`, shaped as `GET /v1/files/:key/variables/local` returns them (collections with modes and default mode, variables with type, values by mode, aliases, scopes, code syntax, descriptions, hidden flags), styles' definitions by style id (what `GET /v1/files/:key/nodes` returns for a style's node), `styles` on each node (its links), `boundVariables` on nodes, paints, gradient stops and effects, and `explicitVariableModes` on frames and instances. `@drawpane/figma` converts that into collections, variables, styles, links, bindings and modes.
- **From `.fig`:** variables and collections from Open Pencil's graph (which reads records' metadata), soft-deleted ones skipped; styles from the records Figma keeps them in (the internal page), adapted like layers; bindings from Open Pencil's per-layer `boundVariables` (which apply instance overrides) and, for effects and gradient stops, which Open Pencil doesn't keep, from the records' `xVar`, `yVar`, `radiusVar`, `spreadVar`, `colorVar` and `stopsVar`.
- **From a link:** the variables endpoint needs the `file_variables:read` scope, and Figma serves it only to members of Enterprise organisations. The Import dialog asks for the scope; without it (or off Enterprise), the file comes in as now, values baked, with a note that its variables need the `.fig`. Style definitions come from the nodes endpoint, one read for all of them.
- **Ids.** A variable is `drawpaneId("VariableID:<guid>")`, a collection `drawpaneId("VariableCollectionId:<guid>")`, a mode `drawpaneId(<mode guid>)` and a style its node's id, the same however the file is read (REST's ids are these strings), so importing again matches them up. A library variable known only by key gets an id derived from its key.
- **Values Figma saved are kept** as the stored fallback, so a binding that can't be followed (a library the file doesn't carry, an expression not yet evaluated) shows what Figma showed.
- **Swapped variants by provenance.** A nested instance swapped to another variant takes, for each look field it doesn't override (its value and its binding both the old component's), the chosen component's value and binding. A binding of its own is an override, kept. The saved colour is not evidence about which variable is bound (a copy in another mode saves another colour, and two variables can agree in one mode); comparing it is a diagnostic only.

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

### 12. Old data: self-describing, never migrated

No stored file is converted. Data says what it means, so a file, a version, a snapshot, a branch and its base, an import from before, a replayed log and a write from an old tab all mean what they meant when they were written.

- **A binding records how its value maps onto its property.** Where this decision reads a value differently from before, the binding carries a `unit`: an opacity binding new code writes is `{ variable, unit: "percent" }` (50 is 50%, as Figma's), and a characters binding is `{ variable, unit: "text" }` (a number or boolean shows as Figma writes it). A binding without one (a plain variable id, as every binding before this decision) keeps its old meaning, resolved at read time: opacity takes a value of 1 or less as a fraction and more as a percentage, and characters takes only text. New code (the editor, the importers, the agent tools) always writes the unit for those keys; the model refuses a unit on any other key.
- **Each binding scales itself.** One variable bound to opacity both ways, or to opacity and a width, needs no copy of it: each layer reads it through its own binding. The variables table shows a variable's value as it is; the inspector and every reader show a bound property through its binding's unit.
- **Nothing else reads differently.** The old `fill` and `stroke` keys resolve as before (the first solid paint's colour, its opacity kept); an alias resolves in its own collection's mode at the layer, as before; a value missing for a mode falls back to the first value stored, as before. Out-of-range values (a negative width, an empty font family) were refused by the old write and showed the stored value; they're now clamped, which changes no stored data's meaning, since such a value was never shown. Text styles' copied values already are their fallbacks.
- So there's no room migration, no copy of a variable made beside it, no version marker in rooms or snapshot headers, and no conversion of a snapshot a client reads. A historical snapshot replayed with its log, a branch merged with its base, a legacy import and a restored version all converge as they are, with no special handling.
- **Protocol 3.** Old data needs nothing, but an older tab can't keep what it doesn't know: it would strip bindings, units and links from what it rewrites. So older tabs don't write. A tab that says hello on protocol 2 is told to reload; one on protocol 1 (from before compact copies, whose sync code reconnects on almost any close) is welcomed as a viewer of a page saying to reload, never the file. Every welcomed socket's attachment records its protocol; one that doesn't say (a socket welcomed by an older release and kept across its update by hibernation) is an old tab: when the room loads it's told to reload, and any edit it sends is refused.

## Phases

| Phase | What | Done when |
| --- | --- | --- |
| 1 | **Import and live resolution.** The model: boolean variables, composed aliases, metadata, 64 modes, paint, stop and effect bindings, every layer binding key, paint and effect styles and links, text style bindings stored. The resolver in the model and in the editor's `Doc`, with the indexes, the invalidation contract and the meter. The edit semantics of section 5. `.fig` import of every variable, collection, paint, effect and text style, with bindings, links and explicit modes, alpha normalised. Library copies remapped. Bindings that say their unit, old data read as it was, and protocol 3; MCP reads resolved. Changing a variable or a mode redraws what it affects, through the Tokens workspace as it is. | The kit's shadows and themed copies draw as Figma's (kit parity run against the baseline); kit-free tests of import, resolution, invalidation (warm against fresh) and old data read as written (replayed snapshots, branches, imports, restores, old sockets); a variable edit and a mode switch touch only what's bound; token-heavy shapes held to the agent meter |
| 2 | **Everywhere a file is read.** The resolver in the rest of the server's readers (thumbnails, SVG and code export through the model); text styles presented, not written; DTCG and CSS export as section 8; DTCG import; variables by link through the REST endpoint where the token allows. | Exports of the kit's themed frames match the canvas |
| 3 | **Editing UI.** Designs first, then the variables table, binding on every field, style pickers, mode pickers on frames, instances and pages, grid styles. | The flows of section 9, e2e-tested |
| 4 | **Libraries.** Publishing variables and styles on their own; binding to a library's; extended collections; review updates for them. | A kit file publishes its tokens and another file themes with them |
| 5 | **Expressions, text runs, agents.** `IS_TRUTHY`, `STRINGIFY`, arithmetic and conditionals evaluated; bindings and style links on text runs; the agent tools of section 11. | The kit's 2,629 visibility expressions come in live |

## Consequences

- A bound value is decided where it's read, so copies stay compact in any mode, and a variable edit, a mode switch or a style edit costs what it reaches, not the file.
- Every reader that computes from layers goes through the resolver: the editor, the agent's headless editor and the MCP reads from phase 1; phase 2 closes the rest (server-side renders and exports). Until then, a server-side render of a themed copy shows its fallback.
- Resolution adds work to reads of bound layers. It's cached per node and dropped only when an index says so; a layer that binds nothing costs one check.
- The file carries both bindings and fallback values: about 30 bytes per bound paint or effect field (a few MB on the kit).
- Figma features without a counterpart yet: variables bound to prototype interactions and conditional logic (phase 5 covers the expressions, not prototyping), `TRANSFORM` scoped variables (x, y, rotation: bindable later on the same model), and variable fonts' axes.
