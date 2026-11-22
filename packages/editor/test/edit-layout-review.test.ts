/**
 * Edits that left layout or sync wrong at PR 286's first head (its
 * independent review, F2 to F8): each ends where a full layout of the
 * document would, in both copy formats where both apply.
 */
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";
import { autoSize } from "../src/text";

const measurer = { width: (_font: string, text: string) => text.length * 8 };

function make(nodes: NodeRecord[], copies: "compact" | "materialized") {
  const editor = new Editor({ measurer, clientId: "review" });
  editor.doc.resetStored(nodes, copies);
  editor.state.set({ role: "editor", viewport: { width: 1200, height: 800 } });
  editor.setPage("p");
  return editor;
}

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });
const page = node("p", "page", ROOT_ID);
const modes = node(
  "c",
  "collection",
  ROOT_ID,
  {
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  },
  "a1",
);
const dark = node(
  "dark",
  "frame",
  "p",
  { variableModes: { c: "dark" }, x: 300, width: 400, height: 200 },
  "a2",
);
const num = (editor: Editor, id: string, prop: "x" | "width" | "height" | "paddingLeft") =>
  getProp(editor.doc.get(id)?.props ?? {}, prop);
const mode = (editor: Editor, id: string) =>
  getProp(editor.doc.get(id)?.props ?? {}, "textAutoResize");

/** What a full layout would still change, and auto-sized text that measures otherwise. */
function unsettled(editor: Editor): unknown[] {
  const frames: string[] = [];
  const texts: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const child of editor.doc.childIds(id)) {
      const n = editor.doc.get(child);
      if (n?.type === "frame") frames.push(child);
      if (n?.type === "text") texts.push(n);
      walk(child);
    }
  };
  walk("p");
  const out: unknown[] = [...layoutOps(editor.doc, frames)];
  for (const text of texts) {
    const size = autoSize(text, measurer);
    if (!size) continue;
    if (Math.round(size.width) !== Math.round(getProp(text.props, "width")))
      out.push({ text: text.id, width: size.width });
    if (Math.round(size.height) !== Math.round(getProp(text.props, "height")))
      out.push({ text: text.id, height: size.height });
  }
  return out;
}

describe.each(["materialized", "compact"] as const)("with copies %s", (copies) => {
  // F2: decision 0043's switch is a laid-out value on the copy, kept by both formats.
  it("keeps an instance's constrained text wrapped through its main's other edits", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 60 }),
        node("label", "text", "main", {
          x: 10,
          y: 10,
          width: 120,
          height: 20,
          characters: "Words wrap here",
          fontSize: 16,
          textAutoResize: "width",
          constraintH: "stretch",
        }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    const label = editor.doc.childIds(instance)[0] as string;
    editor.resize([instance], "width", 100);
    const wrapped = [
      mode(editor, label),
      num(editor, label, "width"),
      num(editor, label, "height"),
    ];
    expect(wrapped).toEqual(["height", 60, 60]);
    editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect([
      mode(editor, label),
      num(editor, label, "width"),
      num(editor, label, "height"),
    ]).toEqual(wrapped);
    expect(getProp(editor.doc.get(label)?.props ?? {}, "overrides")).not.toContain(
      "textAutoResize",
    );
    expect(unsettled(editor)).toEqual([]);
    // Its main's text, stretched like it, gives it the switch too when the constraint comes later.
    editor.setProp(["label"], "constraintH", "start");
    editor.setProp(["label"], "constraintH", "stretch");
    expect(mode(editor, label)).toBe("height");
    expect(unsettled(editor)).toEqual([]);
  });

  // F3 (materialized) and F6 (compact): bound text measured where it shows another mode's words.
  it("measures bound text that a mode set on its main changes in an instance", () => {
    const editor = make(
      [
        page,
        modes,
        node("str", "variable", "c", {
          variableType: "string",
          values: { light: "Hi", dark: "Much longer text in dark" },
        }),
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          width: 16,
          height: 20,
        }),
        node("label", "text", "main", {
          characters: "Hi",
          fontSize: 16,
          width: 16,
          height: 20,
          textAutoResize: "width",
          bindings: { characters: "str" },
        }),
        dark,
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
    const label = editor.doc.childIds(instance)[0] as string;
    expect(num(editor, label, "width")).toBe(192);
    editor.setVariableModes(["main"], "c", "light");
    expect([num(editor, label, "width"), num(editor, instance, "width")]).toEqual([16, 16]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("measures bound text in an instance placed or swapped into another mode", () => {
    const editor = make(
      [
        page,
        modes,
        node("str", "variable", "c", {
          variableType: "string",
          values: { light: "Hi", dark: "Much longer dark text" },
        }),
        node("old", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          width: 40,
          height: 20,
        }),
        node(
          "main",
          "frame",
          "p",
          {
            isComponent: true,
            layoutMode: "row",
            sizingH: "hug",
            sizingV: "hug",
            width: 16,
            height: 20,
          },
          "a1",
        ),
        node("label", "text", "main", {
          characters: "Hi",
          fontSize: 16,
          width: 16,
          height: 20,
          textAutoResize: "width",
          bindings: { characters: "str" },
        }),
        dark,
      ],
      copies,
    );
    editor.select(["dark"]);
    const placed = editor.insertInstance("main") as string;
    expect(editor.doc.get(placed)?.parent).toBe("dark");
    expect(num(editor, placed, "width")).toBe(168);
    const swapped = editor.insertInstance("old", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: swapped, parent: "dark", key: "a1" }])).toBe(true);
    editor.swapInstance(swapped, "main");
    expect(num(editor, swapped, "width")).toBe(168);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the widened oracle: a swap gives a plain instance auto layout with nothing shown in
  // its flow, so it hugs down to its padding.
  it("shrinks an instance swapped to a Hug component whose layers its mode hides", () => {
    const editor = make(
      [
        page,
        modes,
        node("show", "variable", "c", {
          variableType: "boolean",
          values: { light: true, dark: false },
        }),
        node("plain", "frame", "p", { isComponent: true, width: 100, height: 40 }),
        node("box", "rect", "plain", { x: 10, y: 10, width: 20, height: 20 }),
        node(
          "column",
          "frame",
          "p",
          {
            isComponent: true,
            layoutMode: "column",
            sizingH: "hug",
            sizingV: "hug",
            paddingLeft: 4,
            paddingRight: 4,
            paddingTop: 4,
            paddingBottom: 4,
            width: 40,
            height: 20.5,
            x: 200,
          },
          "a1",
        ),
        node("word", "text", "column", {
          x: 4,
          y: 4,
          characters: "Word",
          fontSize: 10,
          width: 32,
          height: 12.5,
          textAutoResize: "width",
          bindings: { visible: "show" },
        }),
        dark,
      ],
      copies,
    );
    const instance = editor.insertInstance("plain", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
    editor.swapInstance(instance, "column");
    expect([num(editor, instance, "width"), num(editor, instance, "height")]).toEqual([8, 8]);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the widened oracle's round trip: a main made fixed width gives its instances that
  // width at once, as redoing the edit did (materialized sync read the instance's old sizing).
  it("gives instances the width of a hugging main resized to a fixed one", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          width: 20,
          height: 10,
        }),
        node("dot", "rect", "main", { width: 20, height: 10 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    editor.resize(["main"], "width", 60);
    expect(getProp(editor.doc.get("main")?.props ?? {}, "sizingH")).toBe("fixed");
    expect(num(editor, instance, "width")).toBe(60);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the widened oracle: a swap to an empty Hug component hugs to that one's padding,
  // though materialized copies take its padding in a second commit.
  it("shrinks an instance swapped to an empty Hug component to that component's padding", () => {
    const pad = (n: number) => ({
      paddingLeft: n,
      paddingRight: n,
      paddingTop: n,
      paddingBottom: n,
    });
    const editor = make(
      [
        page,
        node("full", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          ...pad(4),
          width: 18,
          height: 18,
        }),
        node("dot", "rect", "full", { x: 4, y: 4, width: 10, height: 10 }),
        node(
          "empty",
          "frame",
          "p",
          {
            isComponent: true,
            layoutMode: "row",
            sizingH: "hug",
            sizingV: "hug",
            paddingLeft: 6,
            width: 6,
            height: 0,
            x: 200,
          },
          "a1",
        ),
      ],
      copies,
    );
    const instance = editor.insertInstance("full", { x: 0, y: 300 }) as string;
    editor.swapInstance(instance, "empty");
    expect([num(editor, instance, "width"), num(editor, instance, "height")]).toEqual([6, 0]);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the oracle's constraint check: a swap from an auto layout component to a plain one
  // leaves the new layers where their main layers are, not where the old row placed them.
  it("places a swapped-in plain component's layers where their main layers are", () => {
    const editor = make(
      [
        page,
        node("row", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          paddingLeft: 4,
          paddingTop: 4,
          width: 24,
          height: 24,
        }),
        node("dot", "rect", "row", { x: 4, y: 4, width: 20, height: 20 }),
        node("plain", "frame", "p", { isComponent: true, width: 160, height: 80, x: 200 }, "a1"),
        node("box", "rect", "plain", { x: 10, y: 40, width: 30, height: 20 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("row", { x: 0, y: 300 }) as string;
    editor.swapInstance(instance, "plain");
    const box = editor.doc.childIds(instance)[0] as string;
    expect([num(editor, box, "x"), getProp(editor.doc.get(box)?.props ?? {}, "y")]).toEqual([
      10, 40,
    ]);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the oracle's constraint check: a main layer made absolute stays where it was laid
  // out, and so do its copies in another mode, where their main layer is.
  it("puts a copy where its main layer is once that one leaves the flow", () => {
    const editor = make(
      [
        page,
        modes,
        node("pad", "variable", "c", { variableType: "number", values: { light: 4, dark: 12 } }),
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "column",
          sizingH: "hug",
          sizingV: "hug",
          paddingTop: 4,
          paddingLeft: 4,
          width: 24,
          height: 24,
          bindings: { paddingTop: "pad" },
        }),
        node("dot", "rect", "main", { x: 4, y: 4, width: 20, height: 20 }),
        node("tail", "rect", "main", { x: 4, y: 24, width: 20, height: 0 }, "a1"),
        dark,
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
    const dot = editor.doc.childIds(instance)[0] as string;
    expect(getProp(editor.doc.get(dot)?.props ?? {}, "y")).toBe(12);
    editor.setProp(["dot"], "positioning", "absolute");
    expect(getProp(editor.doc.get(dot)?.props ?? {}, "y")).toBe(4);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the oracle's constraint check: a layer moved into a main is made in its instances
  // where its constraints place it there, not where it is in the main.
  it("makes a copy of a layer moved into a main where its constraints place it", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 100, height: 40 }),
        node("loose", "rect", "p", { x: 300, y: 300, width: 10, height: 10 }, "a1"),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    editor.resize([instance], "height", 60);
    editor.setProp(["loose"], "constraintV", "center");
    expect(
      editor.commit([
        { op: "move", id: "loose", parent: "main", key: "a0" },
        { op: "set", id: "loose", prop: "x", value: 10 },
        { op: "set", id: "loose", prop: "y", value: 15 },
      ]),
    ).toBe(true);
    const copy = editor.doc.childIds(instance)[0] as string;
    expect(getProp(editor.doc.get(copy)?.props ?? {}, "y")).toBe(25);
    expect(unsettled(editor)).toEqual([]);
  });

  // F7: what a main's resize constrains is touched, so its copies follow.
  it("lays out copies of what a main's resize constrains", () => {
    const editor = make(
      [
        page,
        modes,
        node("show", "variable", "c", {
          variableType: "boolean",
          values: { light: false, dark: true },
        }),
        node("main", "frame", "p", { isComponent: true, width: 200, height: 100 }),
        node("inner", "frame", "main", {
          layoutMode: "row",
          x: 10,
          y: 10,
          width: 180,
          height: 40,
          constraintH: "stretch",
        }),
        node("fill", "rect", "inner", {
          width: 180,
          height: 20,
          sizingH: "fill",
          bindings: { visible: "show" },
        }),
        node(
          "label",
          "text",
          "main",
          {
            x: 20,
            y: 60,
            width: 120,
            height: 20,
            characters: "Hi",
            fontSize: 16,
            textAutoResize: "height",
            constraintH: "stretch",
          },
          "a1",
        ),
        dark,
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
    const [inner, label] = editor.doc.childIds(instance) as [string, string];
    const fill = editor.doc.childIds(inner)[0] as string;
    editor.setProp([label], "characters", "Words wrap here");
    editor.resize(["main"], "width", 120);
    expect([num(editor, inner, "width"), num(editor, fill, "width")]).toEqual([100, 100]);
    expect([num(editor, label, "width"), num(editor, label, "height")]).toEqual([40, 60]);
    expect(unsettled(editor)).toEqual([]);
  });
});

describe("with copies compact", () => {
  // F4: a record that unbinds (or stops unbinding) what its main binds rebinds its copy.
  it.each(["unbind", "reset"] as const)(
    "lays out a nested instance's copy in another mode after an %s of its padding",
    (step) => {
      const editor = make(
        [
          page,
          modes,
          node("pad", "variable", "c", { variableType: "number", values: { light: 8, dark: 24 } }),
          node("mainA", "frame", "p", {
            isComponent: true,
            layoutMode: "row",
            width: 100,
            height: 30,
          }),
          node("inner", "frame", "mainA", {
            layoutMode: "row",
            width: 100,
            height: 30,
            paddingLeft: 8,
            bindings: { paddingLeft: "pad" },
          }),
          node("dot", "rect", "inner", { x: 8, width: 10, height: 10 }),
          node("mainB", "frame", "p", { isComponent: true, width: 120, height: 50, x: 200 }, "a1"),
          node("aInB", "frame", "mainB", { instanceOf: "mainA" }),
          dark,
        ],
        "compact",
      );
      const innerInB = editor.doc.childIds("aInB")[0] as string;
      if (step === "reset") editor.unbindVariable([innerInB], "paddingLeft");
      const instance = editor.insertInstance("mainB", { x: 0, y: 400 }) as string;
      expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
      const copyInner = editor.doc.childIds(
        editor.doc.childIds(instance)[0] as string,
      )[0] as string;
      const copyDot = editor.doc.childIds(copyInner)[0] as string;
      expect(unsettled(editor)).toEqual([]);
      if (step === "unbind") editor.unbindVariable([innerInB], "paddingLeft");
      else editor.resetOverrides([{ id: innerInB, props: ["bindings"] }]);
      const want = step === "unbind" ? 8 : 24;
      expect([num(editor, copyInner, "paddingLeft"), num(editor, copyDot, "x")]).toEqual([
        want,
        want,
      ]);
      expect(unsettled(editor)).toEqual([]);
    },
  );

  // Found by the widened oracle: a change inside a main reaches copies of it nested in another
  // main's instance shown in another mode.
  it("lays out a nested copy in another mode when its innermost main changes inside", () => {
    const editor = make(
      [
        page,
        modes,
        node("pad", "variable", "c", { variableType: "number", values: { light: 4, dark: 12 } }),
        node("mainA", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          width: 40,
          height: 20,
        }),
        node("inner", "frame", "mainA", {
          layoutMode: "row",
          width: 40,
          height: 20,
          paddingLeft: 4,
          gap: 2,
          bindings: { paddingLeft: "pad" },
        }),
        node("r", "rect", "inner", { x: 4, width: 8, height: 8 }),
        node("s", "rect", "inner", { x: 14, width: 6, height: 10 }, "a1"),
        node(
          "mainB",
          "frame",
          "p",
          { isComponent: true, layoutMode: "row", sizingH: "hug", sizingV: "hug", x: 200 },
          "a1",
        ),
        dark,
      ],
      "compact",
    );
    editor.select(["mainB"]);
    const nestedA = editor.insertInstance("mainA") as string;
    expect(editor.doc.get(nestedA)?.parent).toBe("mainB");
    const instance = editor.insertInstance("mainB", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
    expect(unsettled(editor)).toEqual([]);
    editor.resize(["r"], "width", 4);
    const copyInner = editor.doc.childIds(editor.doc.childIds(instance)[0] as string)[0] as string;
    const copyS = editor.doc.childIds(copyInner)[1] as string;
    expect(num(editor, copyS, "x")).toBe(18);
    expect(unsettled(editor)).toEqual([]);
  });

  // Found by the widened oracle: a copy of a plain frame given auto layout by its instance lays
  // out what its main's frame holds when that changes.
  it("lays out a copy given auto layout by its instance when its main's layer is hidden", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 100, height: 40 }),
        node("inner", "frame", "main", { width: 100, height: 40 }),
        node("a", "rect", "inner", { x: 0, width: 20, height: 10 }),
        node("b", "rect", "inner", { x: 50, width: 20, height: 10 }, "a1"),
      ],
      "compact",
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    const inner = editor.doc.childIds(instance)[0] as string;
    editor.setLayoutMode([inner], "row");
    const b = editor.doc.childIds(inner)[1] as string;
    // The row reads its gap from where the layers sat: 30.
    expect(num(editor, b, "x")).toBe(50);
    editor.setProp(["a"], "visible", false);
    expect(num(editor, b, "x")).toBe(0);
    expect(unsettled(editor)).toEqual([]);
  });

  // F8: a binding of its own is a layout difference, though its value matches the main's now.
  it("lays out an instance whose only difference is a layout binding of its own", () => {
    const editor = make(
      [
        page,
        modes,
        node("w10", "variable", "c", { variableType: "number", values: { light: 10, dark: 10 } }),
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          width: 100,
          height: 20,
        }),
        node("dot1", "rect", "main", { width: 10, height: 10 }),
        node("dot2", "rect", "main", { x: 10, width: 20, height: 10 }, "a1"),
      ],
      "compact",
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    const [c1, c2] = editor.doc.childIds(instance) as [string, string];
    editor.bindVariable([c1], "width", "w10");
    editor.resize(["dot1"], "width", 50);
    expect([num(editor, c1, "width"), num(editor, c2, "x")]).toEqual([10, 10]);
    expect(unsettled(editor)).toEqual([]);
  });
});

// F5: unsent edits that detach, edit inside, undo twice and move replay through a rebase.
describe("unsent edits rebased on a collaborator's", () => {
  it("replays a detach undone with an edit inside it, without a desync", () => {
    const start = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 100, height: 100 }),
        node("inner", "frame", "main", { width: 50, height: 50 }),
        node("other", "rect", "p", { x: 300, width: 20, height: 20 }, "a1"),
      ],
      "compact",
    );
    const instance = start.insertInstance("main", { x: 0, y: 200 }) as string;
    const innerCopy = start.doc.childIds(instance)[0] as string;
    const nodes = start.doc.stored();

    const editor = new Editor({ measurer, clientId: "c2" });
    editor.state.set({ role: "editor" });
    const sent: { t: string; seq?: number; ops?: unknown[] }[] = [];
    let desync: string | null = null;
    editor.sync.on("desync", (reason: string) => {
      desync = reason;
    });
    editor.sync.connected((m) => sent.push(m as never));
    const receive = (m: unknown) => editor.sync.receive(m as never);
    receive({
      t: "welcome",
      mode: "snapshot",
      revn: 1,
      sessionId: "s1",
      role: "editor",
      peers: [],
      lastSeq: 0,
      copies: "compact",
    });
    receive({ t: "snapshot", nodes, done: true });
    editor.setPage("p");

    editor.select([instance]);
    editor.detachInstances();
    editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, innerCopy);
    editor.undo();
    editor.undo();
    editor.setProp([instance], "x", 50);
    receive({ t: "txn", revn: 2, ops: [{ op: "set", id: "other", prop: "x", value: 350 }] });
    expect(getProp(editor.doc.get(instance)?.props ?? {}, "x")).toBe(50);
    expect(getProp(editor.doc.get(instance)?.props ?? {}, "instanceOf")).toBe("main");
    sent.length = 0;
    editor.sync.flush();
    const txn = sent.find((m) => m.t === "txn");
    expect(txn).toBeTruthy();
    receive({ t: "ack", seq: txn?.seq, revn: 3 });
    expect(desync).toBeNull();
  });
});

// The re-check of cb66985 (C1, C3): a collaborator's edit to the same copy, sent first, and
// this client's unsent one both keep, as the room takes them.
describe("an unsent edit to a copy a collaborator edited first", () => {
  function rooms(move: boolean) {
    const start = make(
      [
        page,
        modes,
        node("pad", "variable", "c", { variableType: "number", values: { light: 4, dark: 12 } }),
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          width: 100,
          height: 100,
          paddingLeft: 4,
          bindings: { paddingLeft: "pad" },
        }),
        node("dot", "rect", "main", { x: 4, width: 20, height: 20 }),
        dark,
      ],
      "compact",
    );
    const instance = start.insertInstance("main", { x: 0, y: 200 }) as string;
    const dot = start.doc.childIds(instance)[0] as string;
    const nodes = start.doc.stored();
    const a = new Editor({ measurer, clientId: "a" });
    a.state.set({ role: "editor" });
    const sent: { t: string; seq?: number; ops?: unknown[] }[] = [];
    const refused: unknown[] = [];
    a.sync.connected((m) => sent.push(m as never));
    a.sync.on("rejected", (code: unknown) => refused.push(code));
    const receive = (m: unknown) => a.sync.receive(m as never);
    receive({
      t: "welcome",
      mode: "snapshot",
      revn: 1,
      sessionId: "s",
      role: "editor",
      peers: [],
      lastSeq: 0,
      copies: "compact",
    });
    receive({ t: "snapshot", nodes, done: true });
    a.setPage("p");
    const b = make(nodes, "compact");
    a.setProp([dot], "fills", [{ type: "solid", color: "#ff0000" }]);
    if (move) b.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }]);
    else b.setProp([dot], "opacity", 0.5);
    const theirs = b.sync.takeUnsent();
    receive({ t: "txn", revn: 2, ops: theirs });
    const room = new Doc();
    room.resetStored(nodes, "compact");
    room.applyStored(theirs as never, { held: true });
    a.sync.flush();
    const txn = sent.find((m) => m.t === "txn");
    expect(txn).toBeTruthy();
    room.applyStored(txn?.ops as never, { held: true });
    receive({ t: "ack", seq: txn?.seq, revn: 3 });
    return { a, room, dot, refused };
  }

  it("keeps both edits to different properties of the same copy", () => {
    const { a, room, dot, refused } = rooms(false);
    const both = (props: NodeRecord["props"]) => [
      getProp(props, "fills"),
      getProp(props, "opacity"),
    ];
    const want = [[{ type: "solid", color: "#ff0000" }], 0.5];
    expect(both(a.doc.get(dot)?.props ?? {})).toEqual(want);
    expect(both(room.get(dot)?.props ?? {})).toEqual(want);
    expect(refused).toEqual([]);
  });

  it("keeps this edit to a copy whose instance a collaborator moved into another mode", () => {
    const { a, room, dot, refused } = rooms(true);
    expect(getProp(room.get(dot)?.props ?? {}, "fills")).toEqual([
      { type: "solid", color: "#ff0000" },
    ]);
    expect(getProp(room.get(dot)?.props ?? {}, "x")).toBe(12);
    expect(getProp(a.doc.get(dot)?.props ?? {}, "x")).toBe(12);
    expect(refused).toEqual([]);
  });
});

// The re-check of cb66985 (F2a to F2d, F2h, R1, R4, R4b): both formats derive a copy's text
// mode and constrained places the same way, and reset clears what was derived.
describe.each(["materialized", "compact"] as const)("deriving copies with copies %s", (copies) => {
  const label = (props: NodeRecord["props"] = {}) =>
    node("label", "text", "main", {
      x: 10,
      y: 10,
      width: 120,
      height: 20,
      characters: "Words wrap here",
      fontSize: 16,
      textAutoResize: "width",
      constraintH: "stretch",
      ...props,
    });
  const setup = (...rest: NodeRecord[]) => {
    const editor = make(
      [page, node("main", "frame", "p", { isComponent: true, width: 160, height: 60 }), ...rest],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    return { editor, instance, copy: editor.doc.childIds(instance)[0] as string };
  };
  const shown = (editor: Editor, id: string) => [
    mode(editor, id),
    num(editor, id, "width"),
    num(editor, id, "height"),
  ];

  it("follows its main's mode where its frame is its main's size (F2a)", () => {
    const { editor, copy } = setup(label());
    editor.setProp(["label"], "textAutoResize", "height");
    editor.setProp(["label"], "textAutoResize", "width");
    expect(mode(editor, copy)).toBe("width");
    expect(unsettled(editor)).toEqual([]);
  });

  it("takes its main's fixed mode after being narrowed (F2b)", () => {
    const { editor, instance, copy } = setup(label());
    editor.resize([instance], "width", 100);
    editor.setProp(["label"], "textAutoResize", "none");
    expect(mode(editor, copy)).toBe("none");
    expect(unsettled(editor)).toEqual([]);
  });

  it("goes back to auto width when its main stops stretching (F2c)", () => {
    const { editor, instance, copy } = setup(label());
    editor.resize([instance], "width", 100);
    editor.setProp(["label"], "constraintH", "start");
    expect(shown(editor, copy)).toEqual(["width", 120, 20]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("is its main's again once its instance is its main's size (F2d)", () => {
    const { editor, instance, copy } = setup(label());
    editor.resize([instance], "width", 100);
    editor.resize([instance], "width", 160);
    editor.setProp(["label"], "characters", "Words wrap here and more");
    expect(shown(editor, copy)).toEqual(["width", 192, 20]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("keeps a stretched group's text wrapped through its main's other edits (F2h)", () => {
    const { editor, instance } = setup(
      node("grp", "group", "main", { constraintH: "stretch" }),
      node("label", "text", "grp", {
        x: 10,
        y: 10,
        width: 120,
        height: 20,
        characters: "Words wrap here",
        fontSize: 16,
        textAutoResize: "width",
      }),
    );
    const copy = editor.doc.childIds(editor.doc.childIds(instance)[0] as string)[0] as string;
    editor.resize([instance], "width", 100);
    expect(shown(editor, copy)).toEqual(["height", 60, 60]);
    editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect(shown(editor, copy)).toEqual(["height", 60, 60]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("clears what was derived when the instance is reset (R1)", () => {
    const { editor, instance, copy } = setup(label());
    editor.resize([instance], "width", 100);
    editor.select([instance]);
    editor.resetInstances();
    expect(num(editor, instance, "width")).toBe(160);
    expect(shown(editor, copy)).toEqual(["width", 120, 20]);
    if (copies === "compact")
      expect(editor.doc.stored().filter((n) => n.type === "override")).toEqual([]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("puts layers back where they sit once a reset takes auto layout away (R4)", () => {
    const { editor, instance, copy } = setup(
      node("dot", "rect", "main", { x: 50, y: 20, width: 10, height: 10 }),
    );
    editor.setLayoutMode([instance], "row");
    editor.select([instance]);
    editor.resetInstances();
    expect([num(editor, copy, "x"), getProp(editor.doc.get(copy)?.props ?? {}, "y")]).toEqual([
      50, 20,
    ]);
  });

  it("places an end-pinned layer by its constraint once its main loses auto layout (R4b)", () => {
    const { editor, instance, copy } = setup(
      node("dot", "rect", "main", { x: 130, y: 20, width: 20, height: 10, constraintH: "end" }),
    );
    editor.resize([instance], "width", 200);
    editor.setLayoutMode(["main"], "row");
    editor.setLayoutMode(["main"], "none");
    expect(num(editor, copy, "x")).toBe(num(editor, "dot", "x") + 40);
  });
});
