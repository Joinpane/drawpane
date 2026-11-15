# 0012. Branches: a file forked at a revision, merged back change by change

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

The PRD's fourth signature idea is live branches: branching a file is instant, review shows what changed (side by side, overlaid or swiped), you accept change by change, and comments anchor to changes. Branches are also how agents will write (decision 0011): an agent works on its own branch and a person merges it.

A file is one FileRoom (Durable Object) holding its nodes and transaction log. The editor, collaboration, history, comments and thumbnails all work per file.

## Decision

1. **A branch is a file.**
   - It has its own FileRoom, made by copying the main file's nodes at a revision. Opening, editing together, history, comments and exports work on it as on any file, with nothing new in the editor's core.
   - D1 `branches` records which file it branches, the main file's revision it started from, who made it and when, and whether it was merged or archived. Branch files stay off the dashboard, search, recent files and the MCP file list; they're reached from their main file.
2. **The base is kept.** When a branch is made, the nodes it starts from are saved as its base snapshot in R2 (`files/<branch>/base.json.gz`). A three-way comparison needs it: what the branch changed is branch against base, and what main changed meanwhile is main against base.
3. **Changes are computed, not logged.** A change is a node the branch added or deleted, or a property it changed (moving counts as changing the parent and key), relative to the base. Comparing snapshots, not replaying logs, means undos, collaborators and restores on the branch all net out.
   - A change **conflicts** when main has changed the same property (or deleted the node, or edited a node the branch deleted) since the base, to something else.
   - Review lists changes by layer, conflicts first.
4. **Review happens on the branch; the merge happens in main's room, as one transaction.**
   - Review opens beside the branch's canvas (the designs' Branch review): the changes on the left, each named by its layer and said in words, conflicts first; what merging will do on the right. The branch side is the live document, so the list follows edits made during review. Base and main come from the API.
   - The reviewer leaves changes out (all are in by default) and picks a side for each conflict.
   - Merging sends those choices, not operations. Main's FileRoom works the changes out again against itself at that moment, so nothing main did since the reviewer looked is overwritten unseen: a conflict nobody decided stops the merge, and review shows main as it is now.
   - The room saves main as a named version first ("Before merging “name”"), which undoes the merge from History, then commits the chosen changes as one ordinary transaction: logged, attributed, and seen arriving by everyone in main. Instances, variables, text and auto layout fix themselves up as for any edit.
   - The API claims the branch before merging, so two people merging at once can't both apply it, and releases it if the merge doesn't go through. Once merged, the branch is read-only history: everyone in it becomes a viewer at once (`merged`), and the Worker reads merged branches as read-only from then on.
5. **Review shows the difference on the canvas.** Main, as review read it, loads into a second read-only editor beside the live branch: side by side (each in half the open canvas), under a swipe, or overlaid. The two views pan, zoom and change page together, and what changed is outlined on each side in its kind's colour, numbered as the list numbers it; picking either selects the other. The branch side stays editable throughout.
6. **Updating a branch from main** takes main's changes since the base into the branch: the same comparison the other way round, worked out in the branch's room against the branch at that moment and applied as one transaction. Where both changed the same thing the branch keeps its own, and the base moves forward to main as it is, so review then shows the branch's value as a plain change against main's current one rather than a conflict. Comments anchored to changes come in a later step.

## Consequences

- Making a branch costs one copy of the file (the same as duplicating it) plus its base snapshot.
- Merging is a normal edit: attributed, in history, safe with others editing, and undone by restoring the version saved just before it.
- Merging in the room, not the reviewer's editor, keeps the merge atomic with main's current state; the price is that it isn't on the reviewer's undo stack, which History covers.
- Structural conflicts are kept simple: a created node whose parent main deleted isn't merged (it's reported); a branch deletion of a node main edited is a conflict. Finer merges (moves within reordered lists) can come later.
