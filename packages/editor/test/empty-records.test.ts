/**
 * Empty override records (PR 286, option 1): an edit that comes to hold nothing of a copy layer's
 * own clears its record's fields and leaves `{ path }`, never deleting the record (so a field a
 * collaborator set meanwhile isn't taken with it). An empty record means nothing, exactly as an
 * absent one: presented, reloaded, converted to materialized copies and back, merged as a branch,
 * carried across a change of the file's form, counted as changes, and reset. Old files have none,
 * so nothing migrates.
 */
import {
  branchChanges,
  compactByInstance,
  expand,
  getProp,
  mergeOps,
  type NodeRecord,
  nodeReader,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { countChanges, overrideGroups, resetAllOverridesOps, runTool } from "../src";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { instanceProperties } from "../src/properties";

const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });

const empty = (r: NodeRecord) =>
  r.type === "override" && Object.keys(r.props).every((k) => k === "path");
const sorted = (records: readonly NodeRecord[]) =>
  [...records].sort((a, b) => a.id.localeCompare(b.id));
/** Every layer as presented: what people see. */
const presented = (doc: Doc) => {
  const out: Record<string, unknown> = {};
  const walk = (id: string) => {
    for (const child of doc.childIds(id)) {
      const node = doc.get(child);
      if (!node) continue;
      out[child] = { parent: node.parent, type: node.type, props: node.props };
      walk(child);
    }
  };
  for (const page of doc.pageIds()) walk(page);
  return out;
};

/** A compact file whose instance's first copy holds an empty record (recoloured, then reset). */
function withEmptyRecord() {
  const editor = new Editor({ clientId: "empty", measurer: { width: () => 5 } });
  editor.doc.resetStored(
    [
      n("p", "page", ROOT_ID),
      n("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
      n("r", "rect", "main", { x: 10, y: 10, width: 60, height: 20 }),
      n("s", "rect", "main", { x: 80, y: 10, width: 20, height: 20 }, "a1"),
    ],
    "compact",
  );
  editor.state.set({ role: "editor" });
  editor.setPage("p");
  const instance = editor.insertInstance("main", { x: 300, y: 0 }) as string;
  const copy = editor.doc.childIds(instance)[0] as string;
  editor.setProp([copy], "fills", [{ type: "solid", color: "#ff0000" }]);
  editor.resetOverrides([{ id: copy, props: ["fills"] }]);
  editor.sync.takeUnsent();
  const stored = editor.doc.stored();
  expect(stored.filter(empty).map((r) => r.id)).toEqual([copy]);
  return { editor, stored, without: stored.filter((r) => !empty(r)), instance, copy };
}

describe("an empty override record means nothing", () => {
  it("reads the same to an agent's tools", async () => {
    const { stored, without, instance } = withEmptyRecord();
    const read = async (records: readonly NodeRecord[]) => {
      const editor = new Editor({ clientId: "agent", measurer: { width: () => 5 } });
      editor.doc.resetStored(records, "compact");
      editor.state.set({ role: "editor" });
      editor.setPage("p");
      return JSON.stringify(await runTool(editor, "get_jsx", { id: instance }));
    };
    expect(await read(stored)).toEqual(await read(without));
  });

  it("presents, reloads and counts as no record", () => {
    const { editor, stored, without, instance } = withEmptyRecord();
    const a = new Doc();
    a.resetStored(stored, "compact");
    const b = new Doc();
    b.resetStored(without, "compact");
    expect(presented(a)).toEqual(presented(b));
    expect(presented(editor.doc)).toEqual(presented(b));
    // Nothing changed in the instance: no override listed, no change counted, nothing to reset.
    expect(overrideGroups(editor.doc, instance)).toEqual([]);
    expect(countChanges(editor.doc, instance, instanceProperties(editor.doc, instance))).toBe(0);
    expect(resetAllOverridesOps(editor.doc, instance)).toEqual([]);
  });

  it("converts to materialized copies and back as no record does", () => {
    const { stored, without } = withEmptyRecord();
    const materialized = expand(stored);
    expect(sorted(materialized)).toEqual(sorted(expand(without)));
    expect(materialized.some((r) => r.type === "override")).toBe(false);
    // Back to compact copies, the record is absent: nothing of the copy's is its own.
    expect(sorted(compactByInstance(materialized).nodes)).toEqual(
      sorted(compactByInstance(expand(without)).nodes),
    );
    // A document loaded either way presents the same.
    const m = new Doc();
    m.resetStored(materialized, "materialized");
    const c = new Doc();
    c.resetStored(stored, "compact");
    expect(Object.keys(presented(m)).length).toBe(Object.keys(presented(c)).length);
  });

  it("merges as a branch, either side holding it", () => {
    const { stored, without } = withEmptyRecord();
    for (const [base, branch] of [
      [stored, without],
      [without, stored],
    ] as const) {
      // The branch moves the main's second layer; the merge applies to main as it is.
      const edited = branch.map((r) =>
        r.id === "s" ? { ...r, props: { ...r.props, x: 90 } } : r,
      ) as NodeRecord[];
      const mainReader = nodeReader(base as NodeRecord[]);
      const branchReader = nodeReader(edited);
      const ops = mergeOps(
        mainReader,
        branchReader,
        branchChanges(mainReader, branchReader, mainReader),
      );
      const merged = new Doc();
      merged.resetStored(base, "compact");
      if (ops.length > 0) merged.applyStored(ops, { held: true });
      const want = new Doc();
      want.resetStored(edited, "compact");
      expect(presented(merged)).toEqual(presented(want));
    }
  });

  it("carries a pending edit across a change of the file's form", () => {
    const { stored, copy } = withEmptyRecord();
    for (const records of [stored, stored.filter((r) => !empty(r))]) {
      const editor = new Editor({ clientId: "form", measurer: { width: () => 5 } });
      editor.state.set({ role: "editor" });
      editor.sync.connected(() => {});
      editor.sync.receive({
        t: "welcome",
        mode: "snapshot",
        revn: 1,
        sessionId: "s",
        role: "editor",
        peers: [],
        lastSeq: 0,
        copies: "compact",
      } as never);
      editor.sync.receive({ t: "snapshot", nodes: records, done: true } as never);
      editor.setPage("p");
      editor.setProp([copy], "opacity", 0.5);
      // The room converted the file to materialized copies meanwhile: the edit is found there.
      editor.sync.receive({
        t: "welcome",
        mode: "snapshot",
        revn: 2,
        sessionId: "s",
        role: "editor",
        peers: [],
        lastSeq: 0,
        copies: "materialized",
      } as never);
      editor.sync.receive({ t: "snapshot", nodes: expand(records), done: true } as never);
      const copyNow = editor.doc
        .childIds(editor.doc.childIds("p").find((id) => id !== "main") as string)
        .at(0) as string;
      expect(getProp(editor.doc.get(copyNow)?.props ?? {}, "opacity")).toBe(0.5);
      expect(editor.sync.pendingCount).toBe(1);
    }
  });
});
