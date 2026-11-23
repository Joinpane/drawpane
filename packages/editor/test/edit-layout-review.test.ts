/**
 * Edits that left layout or sync wrong at PR 286's first head (its
 * independent review, F2 to F8): each ends where a full layout of the
 * document would, in both copy formats where both apply.
 */
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { canMoveInto } from "../src/components";
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
  it("keeps an instance's constrained text sizing itself through its main's other edits", () => {
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
    // Figma (decision 0043, copies): the copy keeps sizing itself, at its main's measured size.
    expect(wrapped).toEqual(["width", 120, 20]);
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
    // A constraint its main's text gains later doesn't switch it either.
    editor.setProp(["label"], "constraintH", "start");
    editor.setProp(["label"], "constraintH", "stretch");
    expect(mode(editor, label)).toBe("width");
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

  it("keeps a stretched group's text sizing itself through its main's other edits (F2h)", () => {
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
    expect(shown(editor, copy)).toEqual(["width", 120, 20]);
    editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect(shown(editor, copy)).toEqual(["width", 120, 20]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("follows its main's mode in a stretched group, nested or not (re-check 3, S3)", () => {
    const { editor, instance } = setup(
      node("outer", "group", "main", { constraintH: "stretch" }),
      node("inner", "group", "outer", { constraintH: "start" }),
      node("label", "text", "inner", {
        x: 10,
        y: 10,
        width: 120,
        height: 20,
        characters: "Words wrap here",
        fontSize: 16,
        textAutoResize: "width",
      }),
    );
    const outer = editor.doc.childIds(instance)[0] as string;
    const copy = editor.doc.childIds(editor.doc.childIds(outer)[0] as string)[0] as string;
    // Unresized: the main's mode, there and back.
    editor.setProp(["label"], "textAutoResize", "height");
    editor.setProp(["label"], "textAutoResize", "width");
    expect(mode(editor, copy)).toBe("width");
    // Narrowed, then an unrelated edit on the main: still the main's mode and size.
    editor.resize([instance], "width", 100);
    editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect(shown(editor, copy)).toEqual(["width", 120, 20]);
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

// The oracle's 300-run seeds (1367222296 and -1453399284): a layer that leaves an auto layout
// frame, by a move in its main or a reset of its instance, sits where its main layer does.
describe.each(["materialized", "compact"] as const)(
  "layers placed again with copies %s",
  (copies) => {
    it("moves a copy out of its instance's row to where its main layer is (seed 1367222296)", () => {
      const editor = make(
        [
          page,
          modes,
          node("pad", "variable", "c", { variableType: "number", values: { light: 4, dark: 12 } }),
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          node("row", "frame", "main", {
            x: 10,
            y: 40,
            width: 140,
            height: 20,
            layoutMode: "row",
            paddingLeft: 4,
            bindings: { paddingLeft: "pad" },
          }),
          node("bar", "rect", "row", { x: 4, width: 136, height: 8, sizingH: "fill" }),
          dark,
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
      expect(editor.commit([{ op: "move", id: "bar", parent: "main", key: "a1" }])).toBe(true);
      const bar = editor.doc.childIds(instance)[1] as string;
      expect(getProp(editor.doc.get(bar)?.props ?? {}, "mirrors")).toBe("bar");
      expect([num(editor, bar, "x"), num(editor, bar, "width")]).toEqual([
        num(editor, "bar", "x"),
        num(editor, "bar", "width"),
      ]);
      expect(unsettled(editor)).toEqual([]);
    });

    it("places a copy layer by the constraint it's given in a resized instance (seed -1039204193)", () => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          node("dot", "rect", "main", { x: 10, y: 10, width: 20, height: 20 }),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      editor.setProp([instance], "height", 40);
      const dot = editor.doc.childIds(instance)[0] as string;
      expect(getProp(editor.doc.get(dot)?.props ?? {}, "y")).toBe(10);
      editor.setProp([dot], "constraintV", "scale");
      // Scaled with its frame: half as tall, so half as far down.
      expect(getProp(editor.doc.get(dot)?.props ?? {}, "y")).toBe(5);
      expect(getProp(editor.doc.get(dot)?.props ?? {}, "height")).toBe(10);
    });

    it("places the layers of a frame moved into a main in its copies' new size (seeds 208567029, 928280465)", () => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          node(
            "box",
            "frame",
            "p",
            { x: 400, y: 10, width: 40, height: 40, constraintV: "stretch" },
            "a1",
          ),
          node("dot", "rect", "box", {
            x: 10,
            y: 10,
            width: 20,
            height: 20,
            constraintV: "center",
          }),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      editor.setProp([instance], "height", 120);
      expect(
        editor.commit([
          { op: "move", id: "box", parent: "main", key: "a0" },
          { op: "set", id: "box", prop: "x", value: 10 },
        ]),
      ).toBe(true);
      const box = editor.doc.childIds(instance)[0] as string;
      const dot = editor.doc.childIds(box)[0] as string;
      // The frame stretches with the instance (40 taller), and the layer stays centred in it.
      expect(num(editor, box, "height")).toBe(80);
      expect(getProp(editor.doc.get(dot)?.props ?? {}, "y")).toBe(30);
    });

    it("lets a stretched copy row keep its Hug height, and what's pinned in it stay (seed 208567029)", () => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          node(
            "box",
            "frame",
            "p",
            {
              x: 400,
              y: 10,
              width: 40,
              height: 20,
              layoutMode: "row",
              sizingV: "hug",
              constraintV: "stretch",
            },
            "a1",
          ),
          node("bar", "rect", "box", { width: 20, height: 20 }),
          node(
            "dot",
            "rect",
            "box",
            { x: 4, y: 4, width: 8, height: 8, positioning: "absolute", constraintV: "center" },
            "a1",
          ),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      editor.setProp([instance], "height", 120);
      expect(
        editor.commit([
          { op: "move", id: "box", parent: "main", key: "a0" },
          { op: "set", id: "box", prop: "x", value: 10 },
        ]),
      ).toBe(true);
      const box = editor.doc.childIds(instance)[0] as string;
      const dot = editor.doc.childIds(box)[1] as string;
      expect(num(editor, box, "height")).toBe(20);
      expect(getProp(editor.doc.get(dot)?.props ?? {}, "y")).toBe(4);
      expect(unsettled(editor)).toEqual([]);
    });

    it("puts a scaled layer where its main layer is after a swap to a bigger component (seed 79905429)", () => {
      const editor = make(
        [
          page,
          node("small", "frame", "p", { isComponent: true, width: 87, height: 25 }),
          node("big", "frame", "p", { isComponent: true, y: 100, width: 160, height: 80 }, "a1"),
          node("bar", "rect", "big", { x: 16, width: 8, height: 8, constraintH: "scale" }),
        ],
        copies,
      );
      const instance = editor.insertInstance("small", { x: 0, y: 300 }) as string;
      editor.swapInstance(instance, "big");
      expect(num(editor, instance, "width")).toBe(160);
      const bar = editor.doc.childIds(instance)[0] as string;
      expect([num(editor, bar, "x"), num(editor, bar, "width")]).toEqual([16, 8]);
    });

    it("shrinks a copy's Hug row once its only layer moves to another component (seed 2040888141)", () => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          node("row", "frame", "main", {
            x: 10,
            y: 40,
            width: 140,
            height: 20,
            layoutMode: "row",
            paddingLeft: 6,
            paddingRight: 6,
          }),
          node("bar", "rect", "row", { x: 6, width: 128, height: 8, sizingH: "fill" }),
          node("other", "frame", "p", { isComponent: true, x: 400, width: 160, height: 80 }, "a1"),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      const row = editor.doc.childIds(instance)[0] as string;
      editor.setProp([row], "sizingH", "hug");
      expect(editor.commit([{ op: "move", id: "bar", parent: "other", key: "a0" }])).toBe(true);
      expect(editor.doc.childIds(row)).toEqual([]);
      expect(num(editor, row, "width")).toBe(12);
      expect(unsettled(editor)).toEqual([]);
    });

    it("puts an instance's layers back once a reset takes its auto layout away (seed -1453399284)", () => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          node("top", "rect", "main", { x: 10, y: 10, width: 70, height: 20 }),
          node("box", "frame", "main", { x: 10, y: 40, width: 140, height: 20 }, "a1"),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      editor.setLayoutMode([instance], "row");
      const box = editor.doc.childIds(instance)[1] as string;
      // The row lays them side by side.
      expect(num(editor, box, "x")).not.toBe(10);
      const own = getProp(editor.doc.get(instance)?.props ?? {}, "overrides");
      expect(own).toContain("layoutMode");
      editor.resetOverrides([{ id: instance, props: own }]);
      expect([num(editor, box, "x"), getProp(editor.doc.get(box)?.props ?? {}, "y")]).toEqual([
        10, 40,
      ]);
    });
  },
);

// The third re-check (at f1b099bd), and Figma's answers probed for it.
describe.each(["materialized", "compact"] as const)("re-check 3 with copies %s", (copies) => {
  const y = (editor: Editor, id: string) => getProp(editor.doc.get(id)?.props ?? {}, "y");
  const hugBox = (parent: string, constraintV: "stretch" | "scale") => [
    node("box", "frame", parent, {
      x: 10,
      y: 10,
      width: 40,
      height: 20,
      layoutMode: "row",
      sizingV: "hug",
      constraintV,
    }),
    node("bar", "rect", "box", { width: 20, height: 20 }),
    node(
      "dot",
      "rect",
      "box",
      { x: 4, y: 4, width: 8, height: 8, positioning: "absolute", constraintV: "scale" },
      "a1",
    ),
  ];

  // Figma: a Hug frame keeps its size; stretched, it's centred in the span stretching would give
  // it; scaled, its centre scales; what's inside it is untouched.
  it.each([
    ["stretch", 120, 30],
    ["stretch", 40, 10],
    ["scale", 120, 20],
    ["scale", 40, 0],
  ] as const)(
    "places a Hug frame pinned by %s in an instance %s tall at y %s",
    (c, height, want) => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
          ...hugBox("main", c),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      editor.resize([instance], "height", height);
      const box = editor.doc.childIds(instance)[0] as string;
      const dot = editor.doc.childIds(box)[1] as string;
      expect([y(editor, box), num(editor, box, "height")]).toEqual([want, 20]);
      expect([y(editor, dot), num(editor, dot, "height")]).toEqual([4, 8]);
      expect(unsettled(editor)).toEqual([]);
    },
  );

  it.each([
    ["stretch", 120, 30],
    ["scale", 120, 20],
    ["scale", 40, 0],
  ] as const)(
    "places a Hug frame pinned by %s in a plain frame %s tall at y %s",
    (c, height, want) => {
      const editor = make(
        [page, node("outer", "frame", "p", { width: 160, height: 80 }), ...hugBox("outer", c)],
        copies,
      );
      editor.resize(["outer"], "height", height);
      expect([y(editor, "box"), num(editor, "box", "height")]).toEqual([want, 20]);
      expect([y(editor, "dot"), num(editor, "dot", "height")]).toEqual([4, 8]);
      expect(unsettled(editor)).toEqual([]);
    },
  );

  it("keeps a stretched text in a Hug frame sizing itself when the frame's frame grows (S1b)", () => {
    const editor = make(
      [
        page,
        node("outer", "frame", "p", { width: 160, height: 80 }),
        ...hugBox("outer", "stretch").slice(0, 2),
        node(
          "lbl",
          "text",
          "box",
          {
            x: 2,
            y: 2,
            width: 40,
            height: 15,
            characters: "Hi",
            fontSize: 10,
            textAutoResize: "width",
            positioning: "absolute",
            constraintV: "stretch",
          },
          "a1",
        ),
      ],
      copies,
    );
    editor.resize(["outer"], "height", 120);
    expect(getProp(editor.doc.get("lbl")?.props ?? {}, "textAutoResize")).toBe("width");
    expect(num(editor, "box", "height")).toBe(20);
  });

  it("places layers given constraints together, frames before what's in them (S5d)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
        node("inner", "frame", "main", { x: 0, width: 100, height: 40 }),
        node("leaf", "rect", "inner", { x: 10, width: 80, height: 10 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    editor.resize([instance], "width", 120);
    const inner = editor.doc.childIds(instance)[0] as string;
    const leaf = editor.doc.childIds(inner)[0] as string;
    editor.setProp([inner, leaf], "constraintH", "stretch");
    expect([num(editor, inner, "width"), num(editor, leaf, "width")]).toEqual([60, 40]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("places what's in a swapped frame for its new size (S5c)", () => {
    const editor = make(
      [
        page,
        node("small", "frame", "p", { isComponent: true, width: 87, height: 25 }),
        node("big", "frame", "p", { isComponent: true, y: 100, width: 160, height: 80 }, "a1"),
        node("inner", "frame", "big", { x: 10, width: 100, height: 40, constraintH: "stretch" }),
        node("leaf", "rect", "inner", { x: 30, width: 20, height: 10, constraintH: "end" }),
      ],
      copies,
    );
    const instance = editor.insertInstance("small", { x: 0, y: 300 }) as string;
    editor.swapInstance(instance, "big");
    const inner = editor.doc.childIds(instance)[0] as string;
    const leaf = editor.doc.childIds(inner)[0] as string;
    expect([num(editor, inner, "width"), num(editor, leaf, "x")]).toEqual([100, 30]);
    expect(unsettled(editor)).toEqual([]);
  });

  it("puts a scaled layer where its main layer is after a nested swap to a bigger component (S5e)", () => {
    const editor = make(
      [
        page,
        node("small", "frame", "p", { isComponent: true, width: 87, height: 25 }),
        node("big", "frame", "p", { isComponent: true, y: 100, width: 160, height: 80 }, "a1"),
        node("bar", "rect", "big", { x: 16, width: 8, height: 8, constraintH: "scale" }),
        node("outer", "frame", "p", { isComponent: true, y: 300, width: 300, height: 200 }, "a2"),
        node("nested", "frame", "outer", { instanceOf: "small", width: 87, height: 25 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("outer", { x: 0, y: 600 }) as string;
    const nested = editor.doc.childIds(instance)[0] as string;
    editor.swapInstance(nested, "big");
    const bar = editor.doc.childIds(nested)[0] as string;
    expect([num(editor, bar, "x"), num(editor, bar, "width")]).toEqual([16, 8]);
  });

  it("gives a copy its main layer's size again once its main stops stretching it (S2)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
        node("bar", "rect", "main", { x: 10, width: 100, height: 10, constraintH: "stretch" }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    editor.resize([instance], "width", 100);
    const bar = editor.doc.childIds(instance)[0] as string;
    expect(num(editor, bar, "width")).toBe(40);
    editor.setProp(["bar"], "constraintH", "start");
    expect(num(editor, bar, "width")).toBe(100);
    expect(unsettled(editor)).toEqual([]);
  });

  it("puts a nested instance where its main layer is once it's pinned to the start, unless moved (E1)", () => {
    const editor = make(
      [
        page,
        node("leaf", "frame", "p", { isComponent: true, width: 20, height: 20 }),
        node("outer", "frame", "p", { isComponent: true, y: 100, width: 160, height: 80 }, "a1"),
        node("nested", "frame", "outer", {
          instanceOf: "leaf",
          x: 10,
          width: 20,
          height: 20,
          constraintH: "end",
        }),
      ],
      copies,
    );
    const instance = editor.insertInstance("outer", { x: 0, y: 300 }) as string;
    editor.resize([instance], "width", 100);
    const nested = editor.doc.childIds(instance)[0] as string;
    expect(num(editor, nested, "x")).toBe(-50);
    editor.setProp(["nested"], "constraintH", "start");
    expect(num(editor, nested, "x")).toBe(10);
    // A person's move of a nested instance is an override, which sync and constraints keep.
    editor.setProp([nested], "x", 33);
    expect(getProp(editor.doc.get(nested)?.props ?? {}, "overrides")).toContain("x");
    editor.setProp(["nested"], "constraintH", "end");
    editor.setProp(["outer"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect(num(editor, nested, "x")).toBe(33);
    // From where it was put, it still follows its pin when the instance widens.
    editor.resize([instance], "width", 120);
    expect(num(editor, nested, "x")).toBe(53);
  });

  it("puts a group's layers back once a reset takes its instance's auto layout away (S4b)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
        node("grp", "group", "main", {}),
        node("a", "rect", "grp", { x: 80, y: 40, width: 10, height: 10 }),
        node("b", "rect", "grp", { x: 100, y: 40, width: 10, height: 10 }, "a1"),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    editor.setProp([instance], "layoutMode", "row");
    const grp = editor.doc.childIds(instance)[0] as string;
    const [a, b] = editor.doc.childIds(grp) as [string, string];
    expect(num(editor, a, "x")).not.toBe(80);
    editor.resetOverrides([{ id: instance, props: ["layoutMode"] }]);
    expect([num(editor, a, "x"), y(editor, a), num(editor, b, "x"), y(editor, b)]).toEqual([
      80, 40, 100, 40,
    ]);
  });

  it("gives a copy its main layer's size back once a reset takes its Hug away (seed 713246673)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
        node("row", "frame", "main", {
          x: 10,
          y: 10,
          width: 40,
          height: 10,
          layoutMode: "row",
          paddingLeft: 4,
        }),
        node("dot", "rect", "row", { x: 4, width: 6, height: 6 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    const row = editor.doc.childIds(instance)[0] as string;
    editor.setProp([row], "sizingH", "hug");
    expect(num(editor, row, "width")).toBe(10);
    editor.resetOverrides([{ id: row, props: ["sizingH"] }]);
    expect(num(editor, row, "width")).toBe(40);
    expect(unsettled(editor)).toEqual([]);
  });

  it("scales a copy from its main layer, not from where an earlier resize left it (seed -41827364)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 20.5 }),
        node("bar", "rect", "main", { x: 10, y: 4, width: 20, height: 10, constraintV: "scale" }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    editor.resize([instance], "height", 19.3);
    editor.resize([instance], "height", 18);
    const bar = editor.doc.childIds(instance)[0] as string;
    // 4 × 18 / 20.5 = 3.512; scaling 3.77 (19.3 tall) again gives 3.52.
    expect(y(editor, bar)).toBe(3.51);
  });
});

// The fourth re-check (at 90db25ca): one derivation (`placedGeometry`) places copies in both
// formats, and these are the cases it found.
describe.each(["materialized", "compact"] as const)("re-check 4 with copies %s", (copies) => {
  const box = (editor: Editor, id: string) => {
    const props = editor.doc.get(id)?.props ?? {};
    return [
      getProp(props, "x"),
      getProp(props, "y"),
      getProp(props, "width"),
      getProp(props, "height"),
    ];
  };
  const hugRow = (sizingV: "hug" | "fixed") => [
    page,
    node("main", "frame", "p", { isComponent: true, width: 160, height: 80 }),
    node("box", "frame", "main", {
      x: 10,
      y: 10,
      width: 40,
      height: 20,
      layoutMode: "row",
      sizingV,
      constraintV: "stretch",
    }),
    node("bar", "rect", "box", { width: 20, height: 20 }),
  ];

  it("keeps a swapped nested instance its component's size (finding 1)", () => {
    const editor = make(
      [
        page,
        node("small", "frame", "p", { isComponent: true, width: 40, height: 20 }),
        node("big", "frame", "p", { isComponent: true, y: 100, width: 80, height: 40 }, "a1"),
        node("outer", "frame", "p", { isComponent: true, y: 200, width: 160, height: 80 }, "a2"),
        node("nested", "frame", "outer", {
          instanceOf: "small",
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          constraintH: "end",
        }),
      ],
      copies,
    );
    const instance = editor.insertInstance("outer", { x: 300, y: 0 }) as string;
    const nested = editor.doc.childIds(instance)[0] as string;
    editor.swapInstance(nested, "big");
    editor.resize([instance], "width", 200);
    expect(box(editor, nested)).toEqual([50, 10, 80, 40]);
    editor.setProp(["nested"], "x", 20);
    expect(box(editor, nested)).toEqual([60, 10, 80, 40]);
  });

  it.each([
    ["hug", "fixed", [10, 60]],
    ["fixed", "hug", [30, 20]],
  ] as const)(
    "places copies again when their main row goes from %s to %s (finding 2)",
    (from, to, want) => {
      const editor = make(hugRow(from), copies);
      const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
      editor.resize([instance], "height", 120);
      editor.setProp(["box"], "sizingV", to);
      const copy = editor.doc.childIds(instance)[0] as string;
      expect(
        box(editor, copy)
          .slice(1, 4)
          .filter((_, i) => i !== 1),
      ).toEqual(want);
      expect(unsettled(editor)).toEqual([]);
    },
  );

  it.each([
    ["sizingV", "fixed", "hug", [10, 20]],
    ["sizingV", "hug", "fixed", [30, 20]],
    ["layoutMode", "none", "hug", [10, 60]],
  ] as const)(
    "places a copy again when it overrides its %s to %s (finding 2)",
    (prop, value, sizing, want) => {
      const editor = make(hugRow(sizing), copies);
      const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
      editor.resize([instance], "height", 120);
      const copy = editor.doc.childIds(instance)[0] as string;
      editor.setProp([copy], prop, value);
      const shown = () => [getProp(editor.doc.get(copy)?.props ?? {}, "y"), box(editor, copy)[3]];
      expect(shown()).toEqual(want);
      editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
      expect(shown()).toEqual(want);
      expect(unsettled(editor)).toEqual([]);
    },
  );

  it("stretches a copy text once it overrides its mode to auto height (finding 2)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", { isComponent: true, width: 160, height: 60 }),
        node("lbl", "text", "main", {
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
    editor.resize([instance], "width", 100);
    const lbl = editor.doc.childIds(instance)[0] as string;
    editor.setProp([lbl], "textAutoResize", "height");
    expect(box(editor, lbl).slice(2)).toEqual([60, 60]);
    editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect(box(editor, lbl).slice(2)).toEqual([60, 60]);
    expect(unsettled(editor)).toEqual([]);
  });

  // Figma, probed live from an uneven start: past its margins, a stretched Hug frame sits at
  // pos + delta / 2 + size (at exactly no room, where it was).
  it.each([
    [130, 17],
    [120, 27],
    [100, 17],
    [80, 7],
    [20, -23],
  ] as const)(
    "places a stretched Hug frame as Figma does when its frame narrows to %s (finding 3)",
    (to, x) => {
      const nodes = (parent: string) => [
        node("row", "frame", parent, {
          x: 17,
          y: 10,
          width: 30,
          height: 20,
          layoutMode: "row",
          sizingH: "hug",
          constraintH: "stretch",
        }),
        node("bar", "rect", "row", { width: 30, height: 20 }),
      ];
      const editor = make(
        [
          page,
          node("plain", "frame", "p", { width: 160, height: 80 }),
          ...nodes("plain"),
          node("main", "frame", "p", { isComponent: true, y: 200, width: 160, height: 80 }, "a1"),
          ...nodes("main").map((n) => ({
            ...n,
            id: `m-${n.id}`,
            parent: n.parent === "row" ? "m-row" : "main",
          })),
        ],
        copies,
      );
      editor.resize(["plain"], "width", to);
      expect(box(editor, "row")[0]).toBe(x);
      const instance = editor.insertInstance("main", { x: 0, y: 400 }) as string;
      editor.resize([instance], "width", to);
      expect(box(editor, editor.doc.childIds(instance)[0] as string)[0]).toBe(x);
    },
  );

  it("ungroups beside a sibling that shares its key (two clients inserting at once)", () => {
    const editor = make(
      [
        page,
        node("frame", "frame", "p", { width: 200, height: 200 }),
        node("grp", "group", "frame", {}, "aA"),
        node("a", "rect", "grp", { x: 10, y: 10, width: 10, height: 10 }),
        node("twin", "rect", "frame", { x: 50, y: 50, width: 10, height: 10 }, "aA"),
      ],
      copies,
    );
    // Equal keys order by id: the group comes first, its twin next.
    expect(editor.doc.childIds("frame")).toEqual(["grp", "twin"]);
    editor.select(["grp"]);
    expect(() => editor.ungroup()).not.toThrow();
    expect(editor.doc.childIds("frame")).toContain("a");
  });

  it("refuses moving a component into one its instances show through a swap (issue 311)", () => {
    const editor = make(
      [
        page,
        node("main0", "frame", "p", { isComponent: true, width: 40, height: 20 }),
        node("main1", "frame", "p", { isComponent: true, y: 100, width: 100, height: 60 }, "a1"),
        node("main2", "frame", "p", { isComponent: true, y: 200, width: 80, height: 40 }, "a2"),
        node("nested", "frame", "main2", { instanceOf: "main0", width: 40, height: 20 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main2", { x: 200, y: 0 }) as string;
    editor.swapInstance(editor.doc.childIds(instance)[0] as string, "main1");
    expect(canMoveInto(editor.doc, ["main2"], "main1")).toBe(false);
    // Made anyway (a raw edit), sync stops at the cycle rather than overflowing its stack.
    expect(() =>
      editor.commit([{ op: "move", id: "main2", parent: "main1", key: "a0" }]),
    ).not.toThrow();
  });
});

// The fifth re-check (at 9a4b6afd): a copy's place and size are owned separately, and a redone
// delete of a main keeps its instances' layers.
describe.each(["materialized", "compact"] as const)("re-check 5 with copies %s", (copies) => {
  const width = (editor: Editor, id: string) => getProp(editor.doc.get(id)?.props ?? {}, "width");

  it.each(["row", "none"] as const)(
    "gives a copy made absolute in a %s frame its main layer's new size (P1)",
    (layoutMode) => {
      const editor = make(
        [
          page,
          node("main", "frame", "p", {
            isComponent: true,
            width: 160,
            height: 80,
            layoutMode,
            paddingLeft: 10,
            paddingTop: 10,
          }),
          node("rect", "rect", "main", { x: 10, y: 10, width: 60, height: 20 }),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
      const rect = editor.doc.childIds(instance)[0] as string;
      editor.setProp([rect], "positioning", "absolute");
      editor.resize(["rect"], "width", 90);
      expect(width(editor, rect)).toBe(90);
      editor.undo();
      expect(width(editor, rect)).toBe(60);
      editor.redo();
      expect(width(editor, rect)).toBe(90);
      editor.setProp([rect], "positioning", "auto");
      expect(width(editor, rect)).toBe(90);
      expect(unsettled(editor)).toEqual([]);
    },
  );

  it("keeps the width a copy took off its main layer's variable when the variable changes", () => {
    const editor = make(
      [
        page,
        node("c", "collection", ROOT_ID, { modes: [{ id: "light", name: "Light" }] }, "a1"),
        node("w10", "variable", "c", { variableType: "number", values: { light: 10 } }),
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          width: 100,
          height: 20,
        }),
        node("dot1", "rect", "main", { width: 10, height: 10, bindings: { width: "w10" } }),
        node("dot2", "rect", "main", { x: 10, width: 20, height: 10 }, "a1"),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    const [dot1, dot2] = editor.doc.childIds(instance) as [string, string];
    editor.unbindVariable([dot1], "width");
    editor.setVariableValue("w10", "light", 50);
    expect(getProp(editor.doc.get("dot1")?.props ?? {}, "width")).toBe(50);
    expect(width(editor, dot1)).toBe(10);
    expect(getProp(editor.doc.get(dot2)?.props ?? {}, "x")).toBe(10);
    expect(unsettled(editor)).toEqual([]);
  });

  it("keeps the size a flow stretched a copy to once its frame takes the flow away", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", {
          isComponent: true,
          width: 160,
          height: 80,
          layoutMode: "row",
          alignItems: "stretch",
        }),
        node("rect", "rect", "main", { width: 60, height: 80 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 200 }) as string;
    editor.resize([instance], "height", 120);
    const rect = editor.doc.childIds(instance)[0] as string;
    expect(getProp(editor.doc.get(rect)?.props ?? {}, "height")).toBe(120);
    editor.setProp([instance], "layoutMode", "none");
    expect(getProp(editor.doc.get(rect)?.props ?? {}, "height")).toBe(120);
    editor.setProp(["main"], "fills", [{ type: "solid", color: "#ff0000" }]);
    expect(getProp(editor.doc.get(rect)?.props ?? {}, "height")).toBe(120);
    expect(unsettled(editor)).toEqual([]);
  });

  it("keeps where a layer kept through its main's delete was put (seed 951286467)", () => {
    const editor = make(
      [
        page,
        node("leaf", "frame", "p", { isComponent: true, width: 160, height: 80 }),
        node("label", "rect", "leaf", { x: 10, y: 10, width: 40, height: 20 }),
        node("mid", "frame", "p", { isComponent: true, y: 200, width: 200, height: 100 }, "a1"),
        node("top", "frame", "p", { isComponent: true, y: 400, width: 240, height: 120 }, "a2"),
      ],
      copies,
    );
    const place = (id: string, parent: string) =>
      expect(editor.commit([{ op: "move", id, parent, key: editor.topKey(parent) }])).toBe(true);
    // An instance of the leaf moved into the middle component, and its label moved there.
    const nested = editor.insertInstance("leaf", { x: 0, y: 600 }) as string;
    place(nested, "mid");
    const moved = editor.doc.childIds(nested)[0] as string;
    editor.setProp([moved], "x", 21);
    // The middle component in the top one, and an instance of the top one.
    const mid = editor.insertInstance("mid", { x: 300, y: 600 }) as string;
    place(mid, "top");
    const instance = editor.insertInstance("top", { x: 600, y: 0 }) as string;
    const kept = () => {
      let at: string | undefined = instance;
      for (let depth = 0; depth < 3 && at; depth++) at = editor.doc.childIds(at)[0];
      return at as string;
    };
    expect(getProp(editor.doc.get(kept())?.props ?? {}, "x")).toBe(21);
    editor.select(["mid"]);
    editor.deleteSelection();
    expect(getProp(editor.doc.get(kept())?.props ?? {}, "x")).toBe(21);
    // A later change to the label's main layer doesn't put it back.
    editor.setProp(["label"], "y", 12);
    expect(getProp(editor.doc.get(kept())?.props ?? {}, "x")).toBe(21);
    expect(unsettled(editor)).toEqual([]);
  });

  it("keeps an instance's layers when the delete of its main is redone (issue 280)", () => {
    const editor = make(
      [
        page,
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          width: 30,
          height: 10,
        }),
        node("inner", "frame", "main", { layoutMode: "row", width: 30, height: 10 }),
        node("dot", "rect", "inner", { width: 10, height: 10 }),
      ],
      copies,
    );
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    const count = () => {
      let n = 0;
      const walk = (id: string) => {
        for (const c of editor.doc.childIds(id)) {
          n++;
          walk(c);
        }
      };
      walk(instance);
      return n;
    };
    editor.select(["main"]);
    editor.deleteSelection();
    expect(count()).toBe(2);
    const kept = width(editor, instance);
    editor.undo();
    expect(count()).toBe(2);
    editor.redo();
    expect(count()).toBe(2);
    expect(width(editor, instance)).toBe(kept);
    expect(unsettled(editor)).toEqual([]);
  });
});
