# 0035. Component properties and overrides, as Figma has them

- Status: proposed
- Date: 2026-11-17
- Deciders: Ziyang (lead maintainer)

## Context

A 500k-layer commercial UI kit imported from a `.fig` (decision 0030) shows how far instances are from Figma's.

- **Properties.** Figma's Button has seven: Variant, State and Size (variants), Show Left Icon, Show Right Icon and Show KbdGroup (booleans) and Button Text (text). Drawpane shows the three variants only. Figma's Field has Orientation, Data Invalid and Description Placement (variants), Label, Description and Link (booleans), Label Text and Description Text (texts), Input Type (an instance swap), and, under a "Textarea" heading, the State and Placeholder Text of the nested Textarea instance, which Field exposes. Drawpane has variants and nothing else: no booleans, texts or swaps, no exposed nested instances. The importer drops `componentPropertyDefinitions` and notes "component-properties".
- **Overrides.** Drawpane lists every overridden property by its internal name. The Button lists nine: `Instance · radius, effects, height, minHeight, variantProps, width` and `Button · position, width, text`. Figma counts one change there: the text. The Field lists more than twenty (`Textarea · alignItems, gap, height, instanceOf, layoutMode …`).

Where the noise comes from, measured on the kit (503,466 nodes, 20,513 instances; the converter's output before `pinInstances`, then after):

| Marked overridden | Converted | Pinned | Why |
| --- | --- | --- | --- |
| `variantProps` on instances | 0 | 14,506 roots, 4,384 nested | Sync copies a variant's `variantProps` onto its instances, so `pinInstances` pins the instances that don't have it. It describes the main, like `componentDescription`, and no instance should hold it. |
| `width`, `height` on roots | 13,939, 9,037 | 11,887, 7,648 | The converter compares a root's size with its main's. Most of these roots hug or fill (`inst=hug main=hug`, `inst=fill main=fixed`), so layout decides their size. |
| `sizingH`, `sizingV` on roots | 7,411, 1,351 | 6,558, 677 | Fill is how an instance sits in its parent (Figma's `layoutGrow`, `layoutAlign`), so it belongs to the instance like its position. |
| `x`, `y`, `width`, `height` inside copies | 26,236, 18,873, 51,689, 29,409 | 24,646, 16,943, 52,619, 32,448 | Layers placed by auto layout, sized by hug or fill, auto-sized text, and children moved or stretched by their constraints in a frame the copy resized. Figma saves these laid out (`derivedSymbolData`, #171) and doesn't count them as overrides. |

Sync (`syncInstanceOps`) already leaves some layout-decided values alone, but only a nested layer's position and size in auto layout, hug sizes and auto-sized text, decided from the main's values. The converter's `markOverrides` checks none of it. `pinInstances` pins whatever sync would still change, so anything sync misses becomes an override.

What's left after that is real in Drawpane's model: a resized instance, a changed fill, a swapped icon. One kind isn't real in Figma: copies in a frame set to another variable mode differ in fills and strokes because the import stores each layer's resolved value. Decision 0034 makes those bindings resolved in the view, so the differences go away there, not here.

## Decision

### Properties

1. **Definitions.** A main component, or a component set for its variants, defines its properties in `componentProps`: an ordered list, at most 64, each with
   - `id`: stable, so renaming keeps every reference;
   - `name` (at most 64 characters), `description` (at most 500);
   - `type`: `variant`, `boolean`, `text`, `instance` (instance swap) or `slot`;
   - `default`: a boolean, a text (at most 10,000 characters) or a component id;
   - `preferred`, for an instance swap: component or set ids, at most 64, in order.

   A variant's values stay in its variants' `variantProps` (they decide which variant an instance is). Its entry in `componentProps` gives it its place in the order and its description. A set without entries for its variants shows them first, as now.
2. **References.** A layer says which of its values a property drives in `propRefs`: `{ visible?, characters?, instanceOf?, slot? }`, each a property id. A boolean drives `visible`, a text `characters`, an instance swap a nested instance's `instanceOf`, a slot a frame's content (decision 0032). One property may drive several layers.
3. **Values live where they act.** An instance's value for a property is the value of the layer it drives, in that instance's copy: Show Left Icon is the icon's `visible`, Button Text the label's `characters`. Setting it sets those layers, which is an override like any other. So nothing new is stored in copies: no per-instance value map, nothing for `CopyView`, materialized sync, the room's conversion or its budgets to learn. Undo, sync and compact records work as they do for any edit.

   We considered Figma's own model, where an instance holds a value per property and its copies apply it. It means a second way for a copy layer to get a value, taught to every path that builds copies (the editor, the room's readers, conversion, the removal check) and held to decision 0029's bounds. What we chose gives the same result as Figma's for every property type, because each property drives exactly one field per layer.
4. **Defaults.** A main's layers hold its defaults: a boolean's layers are visible when its default is true. Changing a default on the main sets those layers, so instances that haven't changed it follow, as any main edit reaches them.
5. **Nested instances.** A nested instance in a main can expose its properties (`exposeProps`, Figma's `isExposedInstance`). An instance shows them under the nested instance's name, below its own, and through exposed instances inside it in turn. A nested instance that isn't exposed keeps its properties to itself, as in Figma.
6. **Renaming, reordering, removing.** Rename and reorder edit `componentProps`. References name ids, so they stay intact. Removing a property removes its references in the main, and its layers keep their current values.

### Overrides

7. **What an override is.** An override is a value a copy holds that layout wouldn't give it. Laid out means one of these:
   - for an instance root: its position, and on an axis where it or its main fills, its sizing and size;
   - a layer placed by its parent's auto layout: its position, and its size on an axis that hugs or fills;
   - a layer that hugs: its size on that axis;
   - auto-sized text: its width when it grows sideways, and its height unless its size is fixed;
   - a child of a frame without auto layout whose size differs from its main's: its position on an axis pinned to the end or centre, and its position and size on one that stretches or scales.

   One function (`laidOutProps` in `@drawpane/model`) decides it for sync, for the converter's `markOverrides` and for `pinInstances`. Laid out values are stored as decision 0029 says ("laid out", not overridden).
8. **Link properties.** `variantProps` and `componentProps` describe a main. Copies don't take them from their main, in either form, like `componentDescription`. `propRefs` and `exposeProps` are copied like any value.
9. **The overrides list** shows what changed, in words, grouped by layer, nested instances under their path ("Textarea › Placeholder"):
   - names a person uses: "Text", "Fill", "Stroke", "Hidden" or "Shown", "Size", "Position", "Corner radius", "Effects", "Swapped to Check";
   - values a property shows above aren't listed again: a property row shows its own changed mark and reset;
   - a reset per item, which resets that value on that layer only. Today's reset syncs the whole instance, which would also undo every laid out value in it;
   - "Reset all", which resets the instance's changes, those inside its nested instances included, as Figma's does.

### The instance panel

10. Like Figma's, one row per property in the definitions' order: a dropdown for a variant (a segmented control for up to three values; a switch when its values are true and false), a switch for a boolean, a text field for a text, a picker for an instance swap (its preferred values first, then the components it can swap to). A row that differs from its main has the component dot beside its label and a reset. Exposed nested instances follow, each under its name as a heading. Then the overrides list, then Swap and Detach.
11. **On a main or set:** the definitions, each with its type, default and description. They can be renamed (double-click), reordered (drag) and removed; "Add property" offers the types and, for a boolean, text or swap, links the selected layer. A layer in a main shows which property drives it, with a way to unlink it.

### Import

12. **REST** (`GET /v1/files/:key`): a component or set's `componentPropertyDefinitions` (keys are `name#id`, variants just `name`; `type`, `defaultValue`, `variantOptions`, `preferredValues` by component key); a layer's `componentPropertyReferences` (`visible`, `characters`, `mainComponent`); an instance's `isExposedInstance`. Keys map to ids of their own, the same every time the same file is imported. Preferred values name components by key, matched to the file's components, or dropped when they're in a library the import doesn't bring.
13. **`.fig`**: Open Pencil's scene graph has the same (`componentPropertyDefinitions`, `componentPropertyReferences`, `isExposedInstance`). `@drawpane/fig`'s adapter writes them in the REST shape, so one converter reads both.
14. **Instances' values** need nothing: a copy's layers already have Figma's values, which now come in as overrides only where they differ by more than layout.

### Everything else

15. **Sync and undo.** Definitions and references are properties set by operations, so collaboration, undo, branches and merges treat them as any value. A definition list is one value: two people editing different properties of one main at once, the later one wins, as with `variantProps` today.
16. **Compact copies and the room's memory.** No new node type, nothing new in override records. A `componentProps` value is bounded by its schema (64 entries; names, descriptions, defaults and preferred lists capped) and counted as any value is (decisions 0026 and 0029). It holds component ids (an instance swap's default and preferred values), so it's listed in `heldNodeIds`: conversion, branch review and libraries see them.
17. **Libraries.** A published component carries its definitions; a swap's default and preferred values that name components in the library are named as the library's copies are. Components whose instances no longer hold `variantProps` show as changed once, at the first publish after this change.
18. **Agent tools** (decision 0021): `get_component_properties` (a component's definitions, an instance's values with what's changed) and `set_instance_properties` (by property name, nested exposed ones by path), which make the same operations as the panel.

## Phases

1. **Import and edit on instances.** Model `componentProps` (boolean, text, instance swap; variant order), `propRefs` and `exposeProps`; import them from REST and `.fig`; the instance panel shows and edits them, nested exposed ones included; the overrides list in words, per-item reset of one value, reset all including nested instances; the noise gone from imports (items 7 and 8). Tests without the kit, an end-to-end test that toggles a boolean and edits a text on an imported instance, and the kit measured with `tools/kit-parity`.
2. **Authoring on mains.** Creating, renaming, reordering and removing properties; defaults and descriptions; linking layers; the main's panel.
3. **Slots** (decision 0032) as a property type.
4. **Libraries and agent tools.**

## How it's verified

- Each laid out case of item 7 has a test where a copy's value differs from its main's: the import doesn't mark it, sync doesn't change it, and changing it by hand marks it.
- The compact equivalence suites (decision 0029) run as before: the rule changes what sync leaves alone, in both forms alike.
- The kit: overrides counted by property before and after, the Button and Field of the screenshots checked by hand, and `kit-parity detach` to see that no more copies are unlinked.

## Consequences

- Instances show Figma's properties and edit them, and the overrides list shows what a person changed.
- An override is defined by layout, not by comparison: a value layout would give a copy isn't one, whatever produced it.
- A copy laid out differently from its main doesn't take its main's values for what layout decides when the main changes; layout gives them again. That's what layout-decided values already did inside auto layout.
- Until decision 0034, copies in a frame of another variable mode list their mode's fills and strokes as overrides.
- Instances of variants hold no `variantProps`: compact files store less (the kit's 18,890 marks, and an `unset` on each such instance).
