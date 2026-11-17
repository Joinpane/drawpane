# 0031. Slot content in copies

- Status: proposed
- Date: 2026-11-17
- Deciders: Ziyang (lead maintainer)

## Context

A 500k-layer commercial UI kit imported into a file that stores compact copies (decision 0029) kept few of its copies linked to their mains: of 221,771 instances (any depth) the converter linked, 7,865 were still instances once stored. Measured with `tools/kit-parity` (`detach`), the losses were import bugs, not things the model can't say:

- Layers inside a nested instance swapped for another component (an icon swapped in a button, everywhere in the kit) copied layers that don't exist: Figma names a layer by its path of instances, the last element the layer in the innermost one's component, and the converter read every path from the outer copy. The swap itself wasn't marked as an override either.
- Layers inside an instance put in a slot, and content a main put in a slot of its nested instance (named under the slot in the main, without it in the main's copies), copied nothing.
- `pinInstances`, which unlinks a copy that syncing would rebuild, unlinked everything inside it, slot content included, and left the copies of a nested instance it unlinked in a main linked, as fake swaps that the compact form can't build (the 1,832 "no copy of" detaches seen on the server).

With those fixed, 187,923 stay instances, none is detached by the compact conversion, and the stored file drops from 499,694 records to 229,281.

What's left, 2,420 copies `pinInstances` unlinks (with what's inside them, apart from instances in their slots, which stay instances), is almost all one thing: **slot content**. A Figma component can make a frame a slot; each instance can put its own layers there, replacing what the main shows in it. Such a copy has layers its main doesn't have and lacks the ones the main has in that slot. Neither materialized sync nor the compact form can express that, so the copy is unlinked to keep its look. (About 120 more are sync's own limit: two sibling instances swapped to the same component share the mirrors of their layers, and sync matches layers by mirror across the whole copy.)

Figma never removes a layer from an instance: it hides it (`visible: false`, which both forms keep as a value) or, in a slot, replaces it. Nothing in the kit lacks a main's layer for another reason. So a "removed" override, as first thought, isn't what's needed.

## Proposal

A copy's slot holds its own layers:

1. **Model.** A main's frame can be a slot (`isSlot`). In a copy, the slot's layer is presented as usual, but its children are the instance's own stored layers when it has any (an override record on the slot's path marks `slotContent: true`, and the layers are stored under the instance root, parented to the slot copy's id), and the main's otherwise. The stored content layers are ordinary layers: their own ids, values and nested instances.
2. **Presenting and syncing.** `CopyView` presents a slot with content from the stored layers instead of building the main's children; materialized sync leaves a slot with content alone. Edits to the main's slot content reach only copies without their own.
3. **Import.** The converter marks slots (the `.fig` reader knows them: `SLOT_CONTENT_ID` properties, decision 0025) and records the content as the instance's; `pinInstances` keeps such a copy linked.
4. **Bounds and checks.** Content is stored layers, so it counts toward the room's limits as any layer; the compact conversion's check (an instance's copies built from the compact form are its materialized layers exactly) covers it, and the equivalence suites gain slot cases.
5. **Editor.** Selecting in a copy's slot edits its content; "reset" clears it back to the main's.

## Consequences

- This touches the model, the room's conversion, sync, the protocol's records and the editor, so it's its own change, measured with the same `detach` step (the 2,420 should fall to about 120).
- Until then, a copy with slot content keeps its look unlinked, and what's in its slots stays linked.
