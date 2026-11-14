# 0010. Team libraries: publish components from one file, use them in others

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

A design system lives in one file and is used in many. Figma calls this a library:
- its owners **publish** the file's components, with a note;
- other files in the team **turn the library on** and insert its components;
- when the library publishes again, those files are told and **review the updates** before taking them, with instances keeping their overrides.

The PRD lists shared team libraries with versioned publishing and update review for v0.2.

Drawpane already has most of the machinery inside one file:
- **Components:** instances are materialized copies linked to a main component in the same document, and an edit to a main is written into its instances in the same transaction (`components.ts`).
- **Versions:** a version is an immutable R2 snapshot of the file's nodes, and every team member can read every team file's versions.

## Decision

**A library is a file with publishes. A file that uses it keeps read-only copies of the parts it uses, and instances are ordinary instances of those copies.**

1. **Publishing.**
   - Publishing saves a named version of the library file (named "Published", or after its note) and records a row in `library_publishes`. The row holds the file, team, version, revision, who published and when, the note, and a manifest of the published components.
   - The manifest gives each component's id, name, description and a content hash of everything it draws (its layers, the components nested in it, and the text styles and variables it uses). So what changed between publishes is known without loading either snapshot.
   - Versions a publish points at are never swept by autosave retention, even if someone un-names them.
2. **Using.**
   - A file that uses a library holds a `library` node under the root, naming the library file and the publish it has taken.
   - When a component is first inserted, its main and everything it depends on are copied from the publish's snapshot into that node: nested mains, text styles, and variable collections with their variables.
   - Copied ids are derived from the library file and the original id (a stable hash). Copies never collide with the file's own nodes, and an update maps old to new by id alone.
   - Copies sit outside every page, so they're never selected, listed among the file's own components, or exported. Instances on pages point at them with `instanceOf`, exactly as at home, so drawing, layout, overrides, swapping and the inspector need nothing new.
3. **Updating.**
   - The Assets panel compares each library node's publish with the library's latest. When they differ, it offers **Review updates**: the components that changed, were added or were removed, from the two manifests.
   - Updating rewrites the copies to match the new snapshot in one undoable transaction. Instances then sync through the existing propagation, keeping their overrides, like any edit to a main.
   - A component the library removed stays in the file: its copy is kept, unchanged, so instances don't break.
4. **Access.** Libraries are per team. Any team member can publish a file they can edit, and any member can use the team's libraries. Images are content-addressed and readable by the team, so copied image fills keep working.

## Consequences

- Rendering, layout, sync and offline editing don't know libraries exist: a file carries everything it draws.
- A library is a normal file: its history, branches (later) and permissions apply.
- Copies make files bigger by what they use from libraries, which is what lets them open offline and stay stable when a library changes.
- This first version publishes components and component sets, with their styles and variables as dependencies. Publishing text styles and variables to be used on their own, per-component update choices and cross-team libraries come later, on the same model.
