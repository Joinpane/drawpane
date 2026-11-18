# 0035. Component properties and overrides, as Figma has them

- Status: proposed
- Date: 2026-11-17 (amended the same day after review: item 3's values have an identity on the instance)
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
3. **Values belong to the instance, by property id.** An instance (a top-level one, or a nested one in a copy or a main) holds the values it sets in `propValues`, keyed by property id: `true` or `false` for a boolean, a text for a text, `{ instance: componentId }` for an instance swap. A key that isn't there means the instance takes what its main gives: the property's default, or, for a nested instance, what the main around it set. Every layer in the instance's copy that references the id (`propRefs`), down to but not inside nested instances, holds the value as an override of the field it drives, so drawing, compact records, conversion, the room's readers and the removal check read layer values as they always have. The record is what lasts; the layer values are where it shows.

   - **Lifetime.** A key lasts until the instance resets it (its row's reset, or Reset all), is detached, or switches to a component outside its set that doesn't define it. Switching variants keeps every key the set defines, whether or not the new variant has a layer that takes it, so a round trip through a variant without the label brings the label's text back. Keys are matched by id, never by layer name, so a label named differently in another variant takes the value. A layer that starts referencing the id (added to the main, linked to the property, or rebuilt by a swap) takes the instance's value in the same transaction. A key whose definition the main removes is dormant: not shown, not applied, and dropped the next time the instance writes its record. A record holds at most 128 keys (a set's and a variant's definitions, at most 64 each), texts bounded as a text layer's `characters` is.
   - **Precedence.** The instance's value comes before its main's default and before what the main around a nested instance set. A direct edit of a field a property drives, inside an instance (typing in the label, hiding the icon, swapping the nested instance), is an edit of the property: it writes the record and every layer the property drives there. So one property's layers can't disagree, and the panel shows the one value. A field no property drives is an ordinary override, as before. Setting a property detaches a variable bound to that field on its layers, as any edit does.
   - **Swapped nested instances.** A nested instance swapped for another component takes that component's values, except where it sits (its root-local values) and the fields the outer component's properties drive: those stay the outer main's. Swapping the icon doesn't show an icon a boolean hides.
   - **Resets restore what a value depends on.** Resetting a property removes its key and restores each layer it drives to its main's stored state for that field: the value, the variable bound to it, and the text style when no other typography stays changed. Resetting a swap rebuilds the nested instance's layers from the component it goes back to. Resetting one variant axis puts that axis back and keeps the others' current values: the instance switches to the variant that has them, and stays changed while any axis differs.
   - **Several layers, one value.** A property that drives several layers has one value. Files from before this record (no `propValues`) may have driven layers that disagree: the panel shows the first changed layer's value, and the next write makes them agree.

   *Why this replaces the first choice.* Phase 1 kept a value only on the layers it drives, reasoning that each property drives exactly one field per layer. The review showed that holds only while the instance's layers stay the same. A variant switch carried overrides by layer name, so a label named differently in the other variant lost its text; a round trip through a variant without a label lost it with no layer to hold it; and a boolean driving two layers showed `false` while its layers were `[false, true]` once the main added the second. Figma keeps an instance's values by property id, which outlives a switch; this does the same, while keeping the applied values on the layers so nothing that reads layers changes.

   *Existing files* need no migration. Their instances have no record, and their values are on the driven layers as overrides, as phase 1 wrote them and as imports bring them. The panel reads them from there, and the first write that needs a record (setting a property, switching a variant, swapping) records every changed property's current value first. Imports don't write records, so what's drawn and the override counts don't change.
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

   One function (`laidOutProps` in `@drawpane/model`) decides it for the converter's `markOverrides` and for `pinInstances`: an import doesn't mark them. Sync and resets don't just leave them alone: a value layout derives from the main's is derived again. A child pinned to the end, centre, both edges or scaled, in a copy frame of another size, takes its main layer's place moved by the constraint (`constrainedValues`), when its main layer moves and when its override is reset. Values auto layout, hug and auto-sized text decide are left to the layout pass, which gives them again. Laid out values are stored as decision 0029 says ("laid out", not overridden).
8. **Link properties.** `variantProps` and `componentProps` describe a main, and `propValues` is what one instance set. Copies don't take them from their main's layers, in either form, like `componentDescription`. `propRefs` and `exposeProps` are copied like any value.
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
14. **Instances' values** come in on the layers: a copy's layers already have Figma's values, which now come in as overrides only where they differ by more than layout. Imports write no `propValues` (item 3: they're recorded at the instance's first write).

### Everything else

15. **Sync and undo.** Definitions, references and records are properties set by operations, so collaboration, undo, branches and merges treat them as any value. The client that sets a property writes the record and the driven layers in one transaction, as it writes an instance's sync; a client that adds a driven layer to a main writes the value into instances that set it, likewise. A definition list is one value, and so is a record: two people setting different properties of one instance at once, the later one wins, as with `variantProps` today.
16. **Compact copies and the room's memory.** No new node type, and nothing new for `CopyView` to present. `propValues` is a value like any other: on a top-level instance it's stored on its root; on a nested instance in a copy it's in that layer's override record, held as a value no layout gives. One record per instance that set a property, bounded by its schema (item 3) and counted as any value is (decisions 0026 and 0029). A `componentProps` value is bounded too (64 entries; names, descriptions, defaults and preferred lists capped). Both hold component ids (a swap's default, preferred values and an instance's chosen component), so they're listed in `heldNodeIds`: conversion, branch review and libraries see them.
17. **Libraries.** A published component carries its definitions; a swap's default and preferred values, and an instance's chosen component in `propValues`, that name components in the library are named as the library's copies are, and a component a swap only prefers is copied with it. Components whose instances no longer hold `variantProps` show as changed once, at the first publish after this change.
18. **Agent tools** (decision 0021): `get_component_properties` (a component's definitions, an instance's values with what's changed) and `set_instance_properties` (by property name, nested exposed ones by path), which make the same operations as the panel.

## Phases

1. **Import and edit on instances.** Model `componentProps` (boolean, text, instance swap; variant order), `propRefs`, `exposeProps` and the instance's record, `propValues` (item 3); import them from REST and `.fig`; the instance panel shows and edits them, nested exposed ones included; the overrides list in words, per-item reset of one value, reset all including nested instances; the noise gone from imports (items 7 and 8). Tests without the kit, an end-to-end test that toggles a boolean and edits a text on an imported instance, and the kit measured with `tools/kit-parity`.
2. **Authoring on mains.** Creating, renaming, reordering and removing properties; defaults and descriptions; linking layers; the main's panel.
3. **Slots** (decision 0032) as a property type.
4. **Libraries and agent tools.**

## How it's verified

- Each laid out case of item 7 has a test where a copy's value differs from its main's: the import doesn't mark it, sync doesn't change it, and changing it by hand marks it. A constraint-placed child also gets its derived place back when its main layer moves and when its override is reset.
- Item 3: a value survives a switch to a variant whose layer has another name, and a round trip through a variant without the layer; a layer the main adds takes it; a direct edit sets every layer; a swap leaves a boolean's value; a reset restores the variable binding; resetting one variant axis keeps the others. Each in both copy forms.
- The compact equivalence suites (decision 0029) run as before: the rule changes what sync leaves alone, in both forms alike.
- The kit: overrides counted by property before and after, the Button and Field of the screenshots checked by hand, and `kit-parity detach` to see that no more copies are unlinked.

## Consequences

- Instances show Figma's properties and edit them, and the overrides list shows what a person changed.
- An instance's property values outlive changes to its layers (variants, renamed layers, layers added), as Figma's do. A set property costs a small record on the instance besides the layer overrides that show it.
- Editing a driven field by hand sets the property, so a text property's layers all change when one is typed in. A person who wants one of them different unlinks it from the property in the main (phase 2).
- An override is defined by layout, not by comparison: a value layout would give a copy isn't one, whatever produced it.
- A copy laid out differently from its main doesn't take its main's values for what layout decides when the main changes; layout gives them again. That's what layout-decided values already did inside auto layout.
- Until decision 0034, copies in a frame of another variable mode list their mode's fills and strokes as overrides.
- Instances of variants hold no `variantProps`, nor an override or an `unset` for it (the kit's 18,890 marks). The number of override records doesn't change: those instances have other differences too.
- Measured with phase 1 on the kit: override marks fall from 294,708 to 160,968, instances with any from 17,825 to 9,282, and what's drawn doesn't change.
- Measured again with item 3's records and the review's fixes, against main at 2db8ab2: override marks 295,576 to 161,797, instances with any 17,825 to 9,282, no instance holds a record after import, and what's drawn doesn't change (761 frames, none changed). Every mark that differs from phase 1's own count came with main's changes since.
