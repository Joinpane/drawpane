import { describe, expect, it } from "vitest";
import {
  applyTransaction,
  COPY_LINK_PROPS,
  CopyView,
  compactByInstance,
  copyChildId,
  copyId,
  expand,
  firstDifference,
  ID_PATTERN,
  MemoryStore,
  ModelError,
  type NodeRecord,
  newId,
  OVERRIDE_KEY,
  type Props,
  ROOT_ID,
  renameIds,
  sha256,
} from "../src/index";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("sha256", () => {
  it("matches the standard's vectors and Node's digests", () => {
    expect(hex(sha256(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(hex(sha256("Zürich 🎨 copies"))).toBe(
      "ca79fe5ec8f443299802f2aa187546ccf29a20c01681d873cffc69ac794b08af",
    );
    expect(hex(sha256("x".repeat(119)))).toBe(
      "000b48d4edf0fa7bee3c6236ecd2785baa5db4eeb8bb54341b029e0d9fa5fb0c",
    );
  });
});

describe("copyId", () => {
  it("is 16 base-62 characters, the same everywhere, and chained through the path", () => {
    const id = copyId("root1", ["a", "b"]);
    expect(id).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(ID_PATTERN.test(id)).toBe(true);
    // Pinned: every client, the server and every tool must derive exactly this.
    expect(id).toBe(copyId("root1", ["a", "b"]));
    expect(id).toBe(copyChildId(copyChildId("root1", "a"), "b"));
    expect(copyId("root1", [])).toBe("root1");
    expect(copyId("root1", ["a", "b"])).not.toBe(copyId("root1", ["b", "a"]));
    expect(copyId("root1", ["ab"])).not.toBe(copyId("root1", ["a", "b"]));
    expect(copyChildId("r", "a")).toMatchInlineSnapshot(`"hdHU8e97pI0gHh8m"`);
  });
});

// ---------------------------------------------------------------------------
// A small materialized document, made the way the editor makes copies.

let keySeq = 0;
const key = () => `a${(keySeq++).toString(36)}`.replace(/0$/, "1");

function node(
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: Record<string, unknown> = {},
  k = key(),
): NodeRecord {
  return { id, type, parent, key: k, props: props as Props };
}

/** Copies a main into `parent` as `instantiateOps` does: every layer stored, `mirrors`-linked. */
function instantiate(
  nodes: NodeRecord[],
  mainId: string,
  parent: string,
  rootId = newId(),
  at = { x: 0, y: 0 },
): string {
  const byParent = (id: string) =>
    nodes
      .filter((n) => n.parent === id)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  const main = nodes.find((n) => n.id === mainId) as NodeRecord;
  const visit = (source: NodeRecord, id: string, into: string, k: string, root: boolean) => {
    const props: Record<string, unknown> = {};
    for (const [p, v] of Object.entries(source.props))
      if (!["isComponent", "componentDescription", "mirrors", "overrides"].includes(p))
        props[p] = v;
    if (root) {
      props.instanceOf = mainId;
      props.x = at.x;
      props.y = at.y;
    } else props.mirrors = source.id;
    nodes.push(node(id, source.type, into, props, k));
    for (const child of byParent(source.id)) visit(child, newId(), id, child.key, false);
  };
  visit(main, rootId, parent, key(), true);
  return rootId;
}

function sample(): { nodes: NodeRecord[]; icon: string; button: string; card: string } {
  const nodes: NodeRecord[] = [node("page1", "page", ROOT_ID, { name: "Page" }, "a0")];
  nodes.push(
    node("icon", "frame", "page1", { name: "Icon", isComponent: true, width: 16, height: 16 }),
  );
  nodes.push(node("glyph", "path", "icon", { pathData: "M0 0L16 16", width: 16, height: 16 }));
  nodes.push(
    node("icon2", "frame", "page1", { name: "Icon 2", isComponent: true, width: 16, height: 16 }),
  );
  nodes.push(node("dot", "ellipse", "icon2", { width: 8, height: 8 }));
  nodes.push(
    node("button", "frame", "page1", {
      name: "Button",
      isComponent: true,
      layoutMode: "row",
      fills: [{ type: "solid", color: "#ff0000" }],
      width: 80,
      height: 24,
    }),
  );
  nodes.push(node("label", "text", "button", { characters: "OK", width: 20, height: 16 }));
  instantiate(nodes, "icon", "button", "btnIcon");
  nodes.push(node("card", "frame", "page1", { name: "Card", isComponent: true, width: 200 }));
  instantiate(nodes, "button", "card", "cardButton");
  return { nodes, icon: "icon", button: "button", card: "card" };
}

const set = (nodes: NodeRecord[], id: string, props: Record<string, unknown>) => {
  const i = nodes.findIndex((n) => n.id === id);
  const n = nodes[i] as NodeRecord;
  const next = { ...n.props } as Record<string, unknown>;
  for (const [p, v] of Object.entries(props)) {
    if (v === undefined) delete next[p];
    else next[p] = v;
  }
  nodes[i] = { ...n, props: next as Props };
};

const copyOf = (nodes: NodeRecord[], root: string, mirrors: string): NodeRecord => {
  const inside = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes)
      if (!inside.has(n.id) && inside.has(n.parent)) {
        inside.add(n.id);
        grew = true;
      }
  }
  return nodes.find((n) => inside.has(n.id) && n.props.mirrors === mirrors) as NodeRecord;
};

/** The converter, its detached instances listed. */
function compact(nodes: readonly NodeRecord[]) {
  const result = compactByInstance(nodes);
  return { ...result, detached: [...result.detached.keys()] };
}

function roundTrip(nodes: NodeRecord[]) {
  const result = compact(nodes);
  const back = expand(result.nodes);
  expect(firstDifference(renameIds(nodes, result.ids), back)).toBeNull();
  return result;
}

describe("compact and expand", () => {
  it("store nothing for copies that equal their main, and give them back", () => {
    const { nodes } = sample();
    const k1 = instantiate(nodes, "card", "page1", "k1", { x: 300, y: 0 });
    const result = roundTrip(nodes);
    expect(result.detached).toEqual([]);
    // Only the instance roots are stored: no records at all.
    expect(result.nodes.filter((n) => n.type === "override")).toEqual([]);
    expect(result.nodes.some((n) => n.props.mirrors)).toBe(false);
    expect(result.nodes.find((n) => n.id === k1)?.props).toEqual({
      instanceOf: "card",
      x: 300,
      y: 0,
    });
  });

  it("keep overridden and laid out values, absences and swaps as records", () => {
    const { nodes } = sample();
    instantiate(nodes, "card", "page1", "k1");
    const label = copyOf(nodes, "k1", copyOf(nodes, "cardButton", "label").id);
    set(nodes, label.id, { characters: "Cancel", width: 44, overrides: ["characters"] });
    // A fill removed from the main's button copy (an absence), and the root resized.
    const button = copyOf(nodes, "k1", "cardButton");
    set(nodes, button.id, { fills: undefined, overrides: ["fills"] });
    set(nodes, "k1", { width: 240, overrides: ["width"] });
    // The icon inside swapped for another: its layers are the other main's.
    const icon = copyOf(nodes, "k1", copyOf(nodes, "cardButton", "btnIcon").id);
    set(nodes, icon.id, { instanceOf: "icon2", overrides: ["instanceOf"] });
    for (const n of nodes.filter((n) => n.parent === icon.id)) nodes.splice(nodes.indexOf(n), 1);
    const dot = nodes.find((n) => n.id === "dot") as NodeRecord;
    nodes.push(node(newId(), "ellipse", icon.id, { ...dot.props, mirrors: "dot" }, dot.key));

    const result = roundTrip(nodes);
    expect(result.detached).toEqual([]);
    const records = result.nodes.filter((n) => n.type === "override");
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.parent).toBe("k1");
      expect(r.key).toBe(OVERRIDE_KEY);
      expect(r.id).toBe(copyId("k1", r.props.path as string[]));
    }
    const labelRecord = records.find((r) => r.props.characters) as NodeRecord;
    expect(labelRecord.props).toEqual({
      path: ["cardButton", copyId("cardButton", ["label"])],
      characters: "Cancel",
      width: 44,
      overrides: ["characters"],
    });
    expect(records.find((r) => r.props.unset)?.props.unset).toEqual(["fills"]);
    // Paths are the ids of the main's layers, as the main presents them: through the
    // nested instance, its copy's id in the card.
    expect(records.find((r) => r.props.instanceOf)?.props.path).toEqual([
      "cardButton",
      copyId("cardButton", ["btnIcon"]),
    ]);
  });

  it("is canonical: expanding and compacting again gives the same stored form", () => {
    const { nodes } = sample();
    instantiate(nodes, "card", "page1", "k1");
    const label = copyOf(nodes, "k1", copyOf(nodes, "cardButton", "label").id);
    set(nodes, label.id, { characters: "Cancel", overrides: ["characters"] });
    const once = compact(nodes).nodes;
    const twice = compact(expand(once));
    expect(firstDifference(once, twice.nodes)).toBeNull();
    // Derived ids map to themselves.
    for (const [from, to] of twice.ids) expect(from).toBe(to);
  });

  it("detaches an instance whose layers aren't its main's, and keeps one whose main is gone", () => {
    const { nodes } = sample();
    instantiate(nodes, "button", "page1", "b1");
    nodes.push(node("stray", "rect", "b1", { width: 4, height: 4 }));
    instantiate(nodes, "icon2", "page1", "orphan");
    const withoutMain = nodes.filter((n) => n.id !== "icon2" && n.parent !== "icon2");
    const result = compact(withoutMain);
    expect(result.detached).toEqual(["b1"]);
    const back = expand(result.nodes);
    expect(back.find((n) => n.id === "stray")?.parent).toBe("b1");
    expect(back.find((n) => n.id === "b1")?.props.instanceOf).toBeUndefined();
    // The orphan keeps its stored layers, still naming the main it had.
    expect(back.find((n) => n.parent === "orphan")?.props.mirrors).toBe("dot");
  });
});

describe("a view of the stored form", () => {
  it("follows a main's change with no write to its copies", () => {
    const { nodes } = sample();
    instantiate(nodes, "card", "page1", "k1");
    const store = new MemoryStore(compact(nodes).nodes);
    const view = new CopyView(store);
    const labelId = copyId("k1", ["cardButton", copyId("cardButton", ["label"])]);
    expect(view.get(labelId)?.props.characters).toBe("OK");
    expect(view.get(labelId)?.props.mirrors).toBe(copyId("cardButton", ["label"]));
    expect(view.childIds(copyId("k1", ["cardButton"]))).toContain(labelId);

    applyTransaction(store, [{ op: "set", id: "label", prop: "characters", value: "Go" }]);
    const { ids } = view.forget(["label"]);
    expect(ids).toContain(copyId("cardButton", ["label"]));
    expect(ids).toContain(labelId);
    expect(view.get(labelId)?.props.characters).toBe("Go");
  });

  it("presents an instance of a variant named after its set", () => {
    const nodes: NodeRecord[] = [
      node("p", "page", ROOT_ID, {}, "a0"),
      node("set", "frame", "p", { name: "Button", isComponentSet: true }),
      node("v1", "frame", "set", { name: "State=Hover", isComponent: true }),
    ];
    instantiate(nodes, "v1", "p", "i1");
    set(nodes, "i1", { name: "Button" });
    const result = roundTrip(nodes);
    expect(result.nodes.find((n) => n.id === "i1")?.props.name).toBeUndefined();
  });
});

describe("override records in a transaction", () => {
  const base = () => {
    const { nodes } = sample();
    instantiate(nodes, "button", "page1", "b1");
    return new MemoryStore(compact(nodes).nodes);
  };

  it("are accepted under an instance root, with the id their path derives", () => {
    const store = base();
    const id = copyId("b1", ["label"]);
    applyTransaction(store, [
      {
        op: "create",
        id,
        type: "override",
        parent: "b1",
        key: OVERRIDE_KEY,
        props: { path: ["label"], characters: "Yes", overrides: ["characters"] },
      },
    ]);
    expect(new CopyView(store).get(id)?.props.characters).toBe("Yes");
  });

  it("are refused anywhere else, under another id, without a path, or moved", () => {
    const store = base();
    const attempt = (op: Parameters<typeof applyTransaction>[1][number]) => {
      try {
        applyTransaction(store, [op]);
        return "ok";
      } catch (error) {
        return (error as ModelError).code;
      }
    };
    const create = (parent: string, id: string, props: Record<string, unknown>) =>
      attempt({ op: "create", id, type: "override", parent, key: OVERRIDE_KEY, props });
    expect(create("button", copyId("button", ["label"]), { path: ["label"] })).toBe(
      "invalid_parent",
    );
    expect(create("page1", copyId("page1", ["label"]), { path: ["label"] })).toBe("invalid_parent");
    expect(create("b1", "notDerived", { path: ["label"] })).toBe("invalid_id");
    expect(create("b1", copyId("b1", ["label"]), {})).toBe("invalid_value");
    expect(create("b1", copyId("b1", ["label"]), { path: ["label"], mirrors: "label" })).toBe(
      "invalid_prop",
    );
    const id = copyId("b1", ["label"]);
    expect(create("b1", id, { path: ["label"], opacity: 0.5 })).toBe("ok");
    expect(attempt({ op: "move", id, parent: "b1", key: "a5" })).toBe("invalid_parent");
    expect(attempt({ op: "set", id, prop: "path", value: ["x"] })).toBe("invalid_prop");
    expect(attempt({ op: "set", id: "b1", prop: "instanceOf", value: null })).toBe("invalid_value");
    expect(attempt({ op: "delete", id })).toBe("ok");
    expect(attempt({ op: "set", id: "b1", prop: "instanceOf", value: null })).toBe("ok");
    expect(ModelError).toBeDefined();
    expect(COPY_LINK_PROPS.has("path")).toBe(true);
  });
});
