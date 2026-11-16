import { describe, expect, it } from "vitest";
import {
  assetHash,
  type DocReader,
  dependencyRoots,
  libraryAssets,
  type NodeRecord,
  nodeReader,
  ROOT_ID,
} from "../src/index";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown> = {},
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

/** A small kit: a text style, a colour variable, an icon, a button using both, and a set of variants. */
const KIT: NodeRecord[] = [
  node("P1", "page", ROOT_ID, "a0", { name: "Kit" }),
  node("ts", "textStyle", ROOT_ID, "a1", { name: "Body", fontSize: 14 }),
  node("col", "collection", ROOT_ID, "a2", { name: "Brand", modes: [{ id: "m1", name: "Light" }] }),
  node("v1", "variable", "col", "a0", {
    name: "primary",
    variableType: "color",
    values: { m1: "#e04f1a" },
  }),
  node("icon", "frame", "P1", "a0", { name: "Icon", isComponent: true, x: 5, y: 6, width: 16 }),
  node("iconPath", "path", "icon", "a0", { width: 16, height: 16, pathData: "M0 0 L16 16" }),
  node("btn", "frame", "P1", "a1", {
    name: "Button",
    isComponent: true,
    x: 100,
    width: 120,
    bindings: { fill: "v1" },
  }),
  node("btnIcon", "frame", "btn", "a0", { width: 16, height: 16, instanceOf: "icon" }),
  node("btnText", "text", "btn", "a1", { characters: "Go", textStyle: "ts", width: 20 }),
  node("set", "frame", "P1", "a2", { name: "Badge", isComponentSet: true, x: 300 }),
  node("badgeA", "frame", "set", "a0", { name: "Size=S", isComponent: true, width: 20 }),
  node("badgeB", "frame", "set", "a1", { name: "Size=L", isComponent: true, width: 40 }),
  node("card", "frame", "P1", "a3", { name: "Card", isComponent: true, x: 500 }),
  node("cardBadge", "frame", "card", "a0", { instanceOf: "badgeB" }),
  node("cardBtn", "frame", "card", "a1", { instanceOf: "btn" }),
];

describe("library manifests", () => {
  it("hash each asset as publishes always have, so earlier manifests still compare equal", () => {
    // Worked out before the hash was taken incrementally: a change here marks every
    // published component of every library as changed.
    expect(libraryAssets(nodeReader(KIT)).map((a) => [a.id, a.hash])).toEqual(EXPECTED_HASHES);
  });

  it("hash a component whose dependencies cover a large file, reading children a page at a time", () => {
    // A component wrapping 200 frames of 100 paths each, read through a reader that counts
    // what it hands out at once.
    const nodes: NodeRecord[] = [
      node("P1", "page", ROOT_ID, "a0"),
      node("all", "frame", "P1", "a0", { name: "All", isComponent: true }),
    ];
    for (let f = 0; f < 200; f++) {
      nodes.push(node(`f${f}`, "frame", "all", `a${String(f).padStart(3, "0")}`));
      for (let p = 0; p < 100; p++)
        nodes.push(
          node(`f${f}p${p}`, "path", `f${f}`, `a${String(p).padStart(3, "0")}`, {
            pathData: `M0 0 L${f} ${p}`,
          }),
        );
    }
    const whole = nodeReader(nodes);
    let widest = 0;
    const paged: DocReader = {
      get: (id) => whole.get(id),
      childIds: () => {
        throw new Error("read every child at once");
      },
      pageIds: () => whole.pageIds(),
      *children(parent: string) {
        const ids = whole.childIds(parent);
        for (let i = 0; i < ids.length; i += 16) {
          const page = ids.slice(i, i + 16);
          widest = Math.max(widest, page.length);
          yield* page;
        }
      },
    };
    expect(assetHash(paged, "all")).toBe(assetHash(whole, "all"));
    expect(dependencyRoots(paged, ["all"])).toEqual(["all"]);
    expect(widest).toBeLessThanOrEqual(16);
  });
});

const EXPECTED_HASHES: Array<[string, string]> = [
  ["icon", "a7ee3a6bffe5c93b"],
  ["btn", "ebf720d2bc7c9650"],
  ["set", "ee9a6010ab55d306"],
  ["card", "387dc5bc8cd3f869"],
];
