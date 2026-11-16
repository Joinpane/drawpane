/**
 * Compact copies (decision 0029) mean the same as materialized ones: a
 * document edited as today, and the same document compacted and edited the
 * same way through the compact view, stay the same document after every
 * step. Copy ids differ between the two (random there, derived here), so the
 * documents are compared as trees, layer by layer in order, with the ids
 * layers name (`mirrors`, `instanceOf`) mapped along.
 */
import { getProp, type NodeRecord, ROOT_ID, samePropValue } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isInstanceRoot, isMainComponent, wouldCycle } from "../src/components";
import { compactCopiesDefault, setCompactCopiesDefault } from "../src/doc";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

function editor(compact: boolean): Editor {
  const previous = compactCopiesDefault();
  setCompactCopiesDefault(compact);
  try {
    const e = new Editor({ measurer, clientId: compact ? "compact" : "materialized" });
    e.state.set({ role: "editor" });
    return e;
  } finally {
    setCompactCopiesDefault(previous);
  }
}

function component(e: Editor, id: string): void {
  e.select([id]);
  e.createComponent();
  e.select([]);
}

function place(e: Editor, componentId: string, parent: string): string {
  e.select([parent]);
  const id = e.insertInstance(componentId, { x: 0, y: 0 }) as string;
  if (e.doc.get(id)?.parent !== parent) {
    const last = e.doc.childIds(parent).at(-1);
    const key = `${e.doc.get(last ?? "")?.key ?? "a0"}V`;
    e.commit([{ op: "move", id, parent, key }]);
  }
  e.select([]);
  return id;
}

/** Icons, a button of a label and an icon, a card of a title and a button; copies of each on a page. */
function kit(): Editor {
  const e = editor(false);
  e.doc.apply([{ op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} }]);
  e.setPage("p");
  const icon = e.createLayer("frame", { x: 600, y: 0, width: 16, height: 16 }, "p") as string;
  e.createLayer("rect", { x: 2, y: 2, width: 12, height: 12 }, icon);
  component(e, icon);
  const icon2 = e.createLayer("frame", { x: 600, y: 40, width: 20, height: 20 }, "p") as string;
  e.createLayer("ellipse", { x: 0, y: 0, width: 20, height: 20 }, icon2);
  component(e, icon2);
  const row = { layoutMode: "row", gap: 8, sizingH: "hug", sizingV: "hug" } as const;
  const pad = { paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 } as const;
  const button = e.createLayer("frame", { x: 600, y: 100, width: 100, height: 40 }, "p", {
    ...row,
    ...pad,
    fills: [{ type: "solid", color: "#ff5a1f" }],
  }) as string;
  const label = e.createLayer("text", { x: 0, y: 0, width: 0, height: 0 }, button) as string;
  e.updateText(label, "Save");
  component(e, button);
  place(e, icon, button);
  const card = e.createLayer("frame", { x: 600, y: 200, width: 200, height: 100 }, "p", {
    ...row,
    ...pad,
    layoutMode: "column",
    fills: [{ type: "solid", color: "#ffffff" }],
  }) as string;
  const title = e.createLayer("text", { x: 0, y: 0, width: 0, height: 0 }, card, {
    fontSize: 20,
  }) as string;
  e.updateText(title, "Card title");
  component(e, card);
  place(e, button, card);

  const toolbar = e.createLayer("frame", { x: 0, y: 0, width: 300, height: 60 }, "p", {
    ...row,
    ...pad,
  }) as string;
  place(e, button, toolbar);
  place(e, button, toolbar);
  place(e, icon, toolbar);
  const board = e.createLayer("frame", { x: 0, y: 200, width: 400, height: 300 }, "p") as string;
  place(e, card, board);
  place(e, card, "p");
  e.history.clear();
  return e;
}

// ---------------------------------------------------------------------------
// Comparing as trees

/** Every layer in order, depth first, with its position. */
function flatten(e: Editor): { id: string; path: number[] }[] {
  const out: { id: string; path: number[] }[] = [];
  const walk = (id: string, path: number[]) => {
    out.push({ id, path });
    e.doc.childIds(id).forEach((child, i) => {
      walk(child, [...path, i]);
    });
  };
  e.doc.pageIds().forEach((page, i) => {
    walk(page, [i]);
  });
  return out;
}

function resolve(e: Editor, path: readonly number[]): string {
  let id = e.doc.pageIds()[path[0] as number] as string;
  for (const i of path.slice(1)) id = e.doc.childIds(id)[i] as string;
  return id;
}

const ID_PROPS = new Set(["mirrors", "instanceOf"]);

/** The first difference between two documents as trees, or null. */
function treeDifference(a: Editor, b: Editor): string | null {
  const map = new Map<string, string>();
  const pairs: [NodeRecord, NodeRecord, string][] = [];
  const walk = (ida: string, idb: string, where: string): string | null => {
    const na = a.doc.get(ida);
    const nb = b.doc.get(idb);
    if (!na || !nb) return `${where}: missing`;
    map.set(ida, idb);
    pairs.push([na, nb, where]);
    const ka = a.doc.childIds(ida);
    const kb = b.doc.childIds(idb);
    if (ka.length !== kb.length)
      return `${where} (${na.type} "${na.props.name ?? ""}"): ${kb.length} layers, expected ${ka.length}`;
    for (let i = 0; i < ka.length; i++) {
      const found = walk(ka[i] as string, kb[i] as string, `${where}/${i}`);
      if (found) return found;
    }
    return null;
  };
  const pa = a.doc.pageIds();
  const pb = b.doc.pageIds();
  if (pa.length !== pb.length) return "pages differ";
  for (let i = 0; i < pa.length; i++) {
    const found = walk(pa[i] as string, pb[i] as string, `page ${i}`);
    if (found) return found;
  }
  for (const [na, nb, where] of pairs) {
    const label = `${where} (${na.type} "${na.props.name ?? ""}")`;
    // Where a hidden layer sits in an auto layout decides nothing (it's out of the flow, and
    // not drawn): the materialized model keeps where it last was, a compact copy where its
    // main has it.
    const unplaced =
      getProp(na.props, "visible") === false &&
      getProp(na.props, "positioning") === "auto" &&
      getProp(a.doc.get(na.parent)?.props ?? {}, "layoutMode") !== "none";
    if (na.type !== nb.type) return `${label}: type ${nb.type}, expected ${na.type}`;
    if (na.key !== nb.key) return `${label}: key ${nb.key}, expected ${na.key}`;
    const pa2 = na.props as Record<string, unknown>;
    const pb2 = nb.props as Record<string, unknown>;
    for (const prop of new Set([...Object.keys(pa2), ...Object.keys(pb2)])) {
      if (ID_PROPS.has(prop)) {
        const want = pa2[prop] ? (map.get(pa2[prop] as string) ?? `?${pa2[prop]}`) : undefined;
        if ((want ?? null) !== ((pb2[prop] as string | undefined) ?? null))
          return `${label}: ${prop} ${pb2[prop]}, expected ${want}`;
        continue;
      }
      if (unplaced && (prop === "x" || prop === "y")) continue;
      if (!samePropValue(prop, pa2[prop], pb2[prop]))
        return `${label}: ${prop} is ${JSON.stringify(pb2[prop])}, expected ${JSON.stringify(pa2[prop])}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edits, each made in both editors on the layer at the same place

type Edit =
  | { kind: "fill"; at: number; color: string }
  | { kind: "opacity"; at: number; value: number }
  | { kind: "hide"; at: number }
  | { kind: "text"; at: number; text: string }
  | { kind: "fontSize"; at: number; size: number }
  | { kind: "gap"; at: number; gap: number }
  | { kind: "width"; at: number; width: number }
  | { kind: "swap"; at: number; to: number }
  | { kind: "reset"; at: number }
  | { kind: "detach"; at: number }
  | { kind: "insert"; main: number; at: number }
  | { kind: "addLayer"; main: number }
  | { kind: "deleteInMain"; at: number }
  | { kind: "undo" }
  | { kind: "redo" };

const edits: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    kind: fc.constant("fill" as const),
    at: fc.nat(),
    color: fc.constantFrom("#00ff00", "#0000ff", "#123456"),
  }),
  fc.record({
    kind: fc.constant("opacity" as const),
    at: fc.nat(),
    value: fc.constantFrom(0.25, 0.5, 1),
  }),
  fc.record({ kind: fc.constant("hide" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("text" as const),
    at: fc.nat(),
    text: fc.constantFrom("OK", "Save changes", "A much longer label", "Card title"),
  }),
  fc.record({
    kind: fc.constant("fontSize" as const),
    at: fc.nat(),
    size: fc.constantFrom(12, 24),
  }),
  fc.record({ kind: fc.constant("gap" as const), at: fc.nat(), gap: fc.constantFrom(0, 4, 16) }),
  fc.record({
    kind: fc.constant("width" as const),
    at: fc.nat(),
    width: fc.constantFrom(60, 180, 260),
  }),
  fc.record({ kind: fc.constant("swap" as const), at: fc.nat(), to: fc.nat() }),
  fc.record({ kind: fc.constant("reset" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("detach" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("insert" as const), main: fc.nat(), at: fc.nat() }),
  fc.record({ kind: fc.constant("addLayer" as const), main: fc.nat() }),
  fc.record({ kind: fc.constant("deleteInMain" as const), at: fc.nat() }),
  fc.constant({ kind: "undo" as const }),
  fc.constant({ kind: "redo" as const }),
);

function insideMain(e: Editor, id: string): boolean {
  return e.doc.ancestors(id).some((n) => isMainComponent(n));
}
function insideInstance(e: Editor, id: string): boolean {
  return e.doc.ancestors(id).some((n) => isInstanceRoot(n));
}
function hasNestedInstance(e: Editor, id: string): boolean {
  const queue = [...e.doc.childIds(id)];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (isInstanceRoot(e.doc.get(at))) return true;
    queue.push(...e.doc.childIds(at));
  }
  return false;
}
const mains = (e: Editor) => flatten(e).filter((n) => isMainComponent(e.doc.get(n.id)));

/** The edit as a function of an editor, picked in `a` by position so `b` gets the same layer. */
function plan(a: Editor, edit: Edit): ((e: Editor) => void) | null {
  const layers = flatten(a).filter((n) => a.doc.get(n.id)?.type !== "page");
  const pick = (at: number, ok: (id: string) => boolean) => {
    const fits = layers.filter((n) => ok(n.id));
    return fits.length === 0 ? null : (fits[at % fits.length] as { path: number[] }).path;
  };
  const type = (id: string) => a.doc.get(id)?.type;
  switch (edit.kind) {
    case "fill":
    case "opacity":
    case "hide": {
      const path = pick(edit.at, (id) => type(id) !== "group");
      if (!path) return null;
      const [prop, value] =
        edit.kind === "fill"
          ? ["fills" as const, [{ type: "solid", color: edit.color }]]
          : edit.kind === "opacity"
            ? ["opacity" as const, edit.value]
            : ["visible" as const, false];
      return (e) => e.setProp([resolve(e, path)], prop, value);
    }
    case "text":
    case "fontSize": {
      const path = pick(edit.at, (id) => type(id) === "text");
      if (!path) return null;
      return edit.kind === "text"
        ? (e) => e.updateText(resolve(e, path), edit.text)
        : (e) => e.setProp([resolve(e, path)], "fontSize", edit.size);
    }
    case "gap": {
      const path = pick(
        edit.at,
        (id) => getProp(a.doc.get(id)?.props ?? {}, "layoutMode") !== "none",
      );
      return path ? (e) => e.setProp([resolve(e, path)], "gap", edit.gap) : null;
    }
    case "width": {
      // Frames and shapes (a shape in a frame without auto layout lays nothing out).
      const path = pick(edit.at, (id) => type(id) !== "text" && type(id) !== "group");
      return path ? (e) => e.setProp([resolve(e, path)], "width", edit.width) : null;
    }
    case "swap": {
      const path = pick(edit.at, (id) => isInstanceRoot(a.doc.get(id)));
      const all = mains(a);
      if (!path || all.length < 2) return null;
      const target = (all[edit.to % all.length] as { path: number[] }).path;
      return (e) => {
        const id = resolve(e, path);
        const to = resolve(e, target);
        const from = getProp(e.doc.get(id)?.props ?? {}, "instanceOf");
        if (from === to) return;
        // Between mains laid out alike (variants are). Across layouts the materialized
        // model first lays the new layers out by the old main's settings, then syncs the
        // root's: an ordering artifact compact copies don't have.
        const layout = (main: string | null) => {
          const p = e.doc.get(main ?? "")?.props ?? {};
          return JSON.stringify(
            ["layoutMode", "paddingLeft", "paddingTop", "gap"].map((k) => getProp(p, k as "gap")),
          );
        };
        if (layout(from) !== layout(to)) return;
        // Never a component inside itself: the editor's swap list leaves those out.
        if (wouldCycle(e.doc, to, e.doc.get(id)?.parent ?? "")) return;
        e.swapInstance(id, to);
      };
    }
    case "reset": {
      const path = pick(edit.at, (id) => isInstanceRoot(a.doc.get(id)));
      return path
        ? (e) => {
            e.select([resolve(e, path)]);
            e.resetInstances();
          }
        : null;
    }
    case "detach": {
      // Detaching keeps nested instances' layers as they are in one model and rebuilds them in
      // the other (it did that already, on the next sync): an instance without nested ones.
      const path = pick(
        edit.at,
        (id) =>
          isInstanceRoot(a.doc.get(id)) && !insideInstance(a, id) && !hasNestedInstance(a, id),
      );
      return path
        ? (e) => {
            e.select([resolve(e, path)]);
            e.detachInstances();
          }
        : null;
    }
    case "insert": {
      const all = mains(a);
      const into = pick(
        edit.at,
        (id) => type(id) === "frame" && !insideInstance(a, id) && !isInstanceRoot(a.doc.get(id)),
      );
      if (all.length === 0 || !into) return null;
      const main = (all[edit.main % all.length] as { path: number[] }).path;
      return (e) => {
        const parent = resolve(e, into);
        const componentId = resolve(e, main);
        // Never a component inside itself, however deep: the editor refuses those.
        if (wouldCycle(e.doc, componentId, parent)) return;
        place(e, componentId, parent);
      };
    }
    case "addLayer": {
      const all = mains(a);
      if (all.length === 0) return null;
      const main = (all[edit.main % all.length] as { path: number[] }).path;
      return (e) => {
        e.createLayer("rect", { x: 1, y: 1, width: 5, height: 5 }, resolve(e, main));
      };
    }
    case "deleteInMain": {
      const path = pick(
        edit.at,
        (id) => insideMain(a, id) && !insideInstance(a, id) && !isMainComponent(a.doc.get(id)),
      );
      return path
        ? (e) => {
            e.select([resolve(e, path)]);
            e.deleteSelection();
          }
        : null;
    }
    case "undo":
      return (e) => e.undo();
    case "redo":
      return (e) => e.redo();
  }
}

describe("compact copies mean what materialized copies do", () => {
  it("compacts the starting document to the same tree", () => {
    const a = kit();
    const b = editor(true);
    b.doc.reset([...a.doc.nodes()]);
    b.setPage(b.doc.pageIds()[0] as string);
    expect(b.doc.compactCopies).toBe(true);
    expect(b.doc.stored().length).toBeLessThan(a.doc.size);
    expect(treeDifference(a, b)).toBeNull();
  });

  /** `REPLAY='[…edits…]'` replays a failing sequence, printing each step's commits and difference. */
  it.skipIf(!process.env.REPLAY)("replays one sequence", () => {
    const sequence = JSON.parse(process.env.REPLAY as string) as Edit[];
    const a = kit();
    const b = editor(true);
    b.doc.reset([...a.doc.nodes()]);
    b.setPage(b.doc.pageIds()[0] as string);
    for (const edit of sequence) {
      const run = plan(a, edit);
      if (!run) continue;
      const commits: string[] = [];
      for (const e of [a, b]) {
        const commit = e.commit.bind(e);
        e.commit = (ops, label, options) => {
          commits.push(
            `${e === a ? "A" : "B"} ${label}: ${ops.map((o) => `${o.op} ${o.id}${o.op === "set" ? `.${o.prop}` : ""}`).join("; ")}`,
          );
          return commit(ops, label, options);
        };
      }
      run(a);
      run(b);
      console.log(`${JSON.stringify(edit)}\n  ${commits.join("\n  ")}`);
      console.log(treeDifference(a, b), "notices:", a.s.notice?.text, "|", b.s.notice?.text);
    }
  });

  it("stays the same document through any sequence of edits", { timeout: 600_000 }, () => {
    fc.assert(
      fc.property(fc.array(edits, { minLength: 1, maxLength: 12 }), (sequence) => {
        const a = kit();
        const b = editor(true);
        b.doc.reset([...a.doc.nodes()]);
        b.setPage(b.doc.pageIds()[0] as string);
        const done: Edit[] = [];
        for (const edit of sequence) {
          const run = plan(a, edit);
          if (!run) continue;
          done.push(edit);
          run(a);
          run(b);
          const difference = treeDifference(a, b);
          if (difference) throw new Error(`after ${JSON.stringify(done)}:\n${difference}`);
        }
      }),
    );
  });
});
