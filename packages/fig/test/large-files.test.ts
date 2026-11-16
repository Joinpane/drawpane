/**
 * Files real kits are made of that the samples don't show on their own:
 * links to a library's styles the file didn't save, variables computed
 * from expressions, and files too large for one Drawpane file, whose pages
 * are estimated up front, chosen, and built a few at a time.
 *
 * The odd cases are made by patching a committed sample's records the way
 * Figma would have saved them (Open Pencil's `patchFigArchive`).
 */
import { readFileSync } from "node:fs";
import { convertFile, type Figma } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { type FigPage, openFig, planPasses, readFig } from "../src";
import { estimateLayers } from "../src/estimate";
import { prepareVariables } from "../src/variables";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A sample with some of its records' fields written over. */
function patched(
  bytes: Uint8Array,
  set: (records: NodeChange[]) => [NodeChange, Partial<NodeChange>][],
) {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const fields = set(parsed.nodeChanges).map(([record, fields]) => ({
    guid: record.guid as NonNullable<NodeChange["guid"]>,
    set: fields,
    unset: [],
  }));
  return patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records: [], fields, blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
}

/** Every node of a REST file, depth first. */
function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

const IS_TRUTHY = {
  dataType: "EXPRESSION",
  resolvedDataType: "BOOLEAN",
  value: {
    expressionValue: {
      expressionFunction: "IS_TRUTHY",
      expressionArguments: [{ dataType: "FLOAT", value: { floatValue: 1 } }],
    },
  },
};

// Each reads and builds a sample (twice, some of them): seconds under a full parallel run.
describe("files real kits are made of", { timeout: 60_000 }, () => {
  it("reads layers linked to a library's style the file didn't save, keeping their own values", async () => {
    const bytes = fixture("medianova.fig");
    let text: NodeChange | undefined;
    const fig = await readFig(
      patched(bytes, (rs) => {
        text = rs.find((r) => r.type === "TEXT" && !r.styleIdForText);
        return [
          [
            text as NodeChange,
            {
              styleIdForText: { assetRef: { key: "0123abcd", version: "1:1" } },
            } as Partial<NodeChange>,
          ],
        ];
      }),
    );
    const before = await readFig(bytes);
    const id = (r: NodeChange) => `${r.guid?.sessionID}:${r.guid?.localID}`;
    const find = (file: Figma.File) =>
      [...walk(file.document)].find((n) => n.id === id(text as NodeChange));
    expect(find(fig.file)?.style).toEqual(find(before.file)?.style);
  });

  it("reads a file with a variable computed from an expression", async () => {
    const fig = await readFig(
      patched(fixture("pattern.fig"), (rs) => {
        const variable = rs.find((r) => r.type === "VARIABLE") as NodeChange & {
          variableDataValues: { entries: { modeID: unknown; variableData: unknown }[] };
        };
        const entries = variable.variableDataValues.entries.map((e) => ({
          ...e,
          variableData: IS_TRUTHY,
        }));
        return [[variable, { variableDataValues: { entries } } as Partial<NodeChange>]];
      }),
    );
    expect(fig.pages).toBeGreaterThan(0);
  });

  it("reads layers inside components bound to an expression, keeping their saved values", async () => {
    const bytes = fixture("medianova.fig");
    const fig = await readFig(
      patched(bytes, (rs) => {
        const used = new Set(
          rs
            .filter((r) => r.type === "INSTANCE")
            .map((r) => `${r.symbolData?.symbolID?.sessionID}:${r.symbolData?.symbolID?.localID}`),
        );
        const inMains = rs.filter(
          (r) =>
            r.parentIndex?.guid &&
            used.has(`${r.parentIndex.guid.sessionID}:${r.parentIndex.guid.localID}`),
        );
        expect(inMains.length).toBeGreaterThan(0);
        return inMains.map((r) => [
          r,
          {
            variableConsumptionMap: {
              entries: [{ variableField: "VISIBLE", variableData: IS_TRUTHY }],
            },
          } as unknown as Partial<NodeChange>,
        ]);
      }),
    );
    const before = await readFig(bytes);
    expect(fig.layers).toBe(before.layers);
  });

  it("takes out only the bindings Open Pencil can't evaluate", () => {
    const alias = { value: { alias: { guid: { sessionID: 1, localID: 2 } } }, dataType: "ALIAS" };
    const times = {
      dataType: "EXPRESSION",
      value: {
        expressionValue: {
          expressionFunction: "MULTIPLY",
          expressionArguments: [alias, { dataType: "FLOAT", value: { floatValue: 2 } }],
        },
      },
    };
    const entry = (variableField: string, variableData: unknown) => ({
      variableField,
      variableData,
    });
    const record = {
      type: "FRAME",
      variableConsumptionMap: {
        entries: [entry("WIDTH", alias), entry("HEIGHT", times), entry("VISIBLE", IS_TRUTHY)],
      },
      symbolData: {
        symbolOverrides: [{ variableConsumptionMap: { entries: [entry("VISIBLE", IS_TRUTHY)] } }],
      },
      textData: {
        styleOverrideTable: [
          { parameterConsumptionMap: { entries: [entry("FONT_SIZE", IS_TRUTHY)] } },
        ],
      },
    };
    expect(prepareVariables([record as unknown as NodeChange])).toBe(3);
    expect(record.variableConsumptionMap.entries.map((e) => e.variableField)).toEqual([
      "WIDTH",
      "HEIGHT",
    ]);
    expect(record.symbolData.symbolOverrides[0]?.variableConsumptionMap.entries).toEqual([]);
  });
});

describe("files too large for one Drawpane file", { timeout: 60_000 }, () => {
  it("estimates each page's layers, near what building them gives", async () => {
    for (const name of ["pattern.fig", "tailwind-ecklf.fig", "medianova.fig"]) {
      const opened = await openFig(fixture(name));
      const built = await opened.read();
      expect(opened.layers, name).toBeGreaterThan(built.layers * 0.5);
      expect(opened.layers, name).toBeLessThan(built.layers * 2);
      expect(opened.pages.map((p) => p.name)).toEqual(
        (built.file.document.children ?? []).map((p) => p.name),
      );
    }
  });

  it("counts what an instance's slots and swaps put in it, not the main's defaults", () => {
    let next = 1;
    const guid = () => ({ sessionID: 1, localID: next++ });
    const rec = (type: string, parent: { guid: object } | null, extra: object = {}) =>
      ({
        type,
        guid: guid(),
        ...(parent ? { parentIndex: { guid: parent.guid, position: "a" } } : {}),
        ...extra,
      }) as unknown as NodeChange & { guid: { sessionID: number; localID: number } };
    const doc = rec("DOCUMENT", null);
    const page = rec("CANVAS", doc);
    const internal = rec("CANVAS", doc, { internalOnly: true });
    const slotDef = { sessionID: 9, localID: 1 };
    const swapDef = { sessionID: 9, localID: 2 };
    // A card whose "Items" slot holds three layers by default.
    const card = rec("SYMBOL", internal);
    const items = rec("FRAME", card, {
      componentPropRefs: [{ defID: slotDef, componentPropNodeField: "SLOT_CONTENT_ID" }],
    });
    const defaults = [rec("TEXT", items), rec("TEXT", items), rec("TEXT", items)];
    // What one copy put in the slot instead: one layer.
    const content = rec("FRAME", internal, { isSlotContent: true });
    const mine = rec("TEXT", content);
    // An icon button whose icon is an instance swap: small by default, swapped for a larger one.
    const small = rec("SYMBOL", internal);
    const dot = rec("ELLIPSE", small);
    const large = rec("SYMBOL", internal);
    const parts = [1, 2, 3, 4, 5].map(() => rec("VECTOR", large));
    const button = rec("SYMBOL", internal);
    const icon = rec("INSTANCE", button, {
      symbolData: { symbolID: small.guid },
      componentPropRefs: [{ defID: swapDef, componentPropNodeField: "OVERRIDDEN_SYMBOL_ID" }],
    });
    const cardCopy = rec("INSTANCE", page, {
      symbolData: { symbolID: card.guid },
      componentPropAssignments: [
        { defID: slotDef, varValue: { value: { slotContentIdValue: { guid: content.guid } } } },
      ],
    });
    const buttonCopy = rec("INSTANCE", page, {
      symbolData: { symbolID: button.guid },
      componentPropAssignments: [
        { defID: swapDef, varValue: { value: { symbolIdValue: { guid: large.guid } } } },
      ],
    });
    const plain = rec("INSTANCE", page, { symbolData: { symbolID: card.guid } });
    const all = [
      doc,
      page,
      internal,
      card,
      items,
      ...defaults,
      content,
      mine,
      small,
      dot,
      large,
      ...parts,
      button,
      icon,
      cardCopy,
      buttonCopy,
      plain,
    ];
    const sizes = estimateLayers(all, [page]);
    // Card copy: itself, Items, its one layer. Button copy: itself, the icon, the larger icon's 5.
    // The plain card: itself, Items and the 3 defaults.
    expect(sizes.get(`${page.guid.sessionID}:${page.guid.localID}`)).toBe(3 + 7 + 5);
  });

  it("builds only the chosen pages; copies of components left out come in detached, and say so", async () => {
    const opened = await openFig(fixture("medianova.fig"));
    const all = await opened.read();
    // The page whose instances use components on another page.
    const mains = new Map<string, string>();
    for (const page of all.file.document.children ?? [])
      for (const n of walk(page)) if (n.type === "COMPONENT") mains.set(n.id, page.id);
    const user = (all.file.document.children ?? []).find((page) =>
      [...walk(page)].some(
        (n) =>
          n.type === "INSTANCE" &&
          mains.has(n.componentId ?? "") &&
          mains.get(n.componentId ?? "") !== page.id,
      ),
    );
    expect(user).toBeDefined();
    const part = await opened.read({ pageIds: [user?.id as string] });
    expect((part.file.document.children ?? []).map((p) => p.id)).toEqual([user?.id]);
    const notes = (file: Figma.File) => Object.fromEntries(convertFile(file).notes.entries());
    // Its own library copies stay library copies; copies of the other page's components say so.
    expect(notes(part.file)["component-omitted"]).toBeGreaterThan(0);
    expect(notes(part.file)["library-component"]).toBe(notes(all.file)["library-component"]);
    expect(notes(all.file)["component-omitted"]).toBeUndefined();
  });

  it("builds a large file's pages a few at a time, by their estimates", () => {
    const page = (id: string, layers: number): FigPage => ({ id, name: id, layers });
    const pages = [
      page("a", 30_000),
      page("b", 9_000),
      page("c", 5_000),
      page("d", 90_000),
      page("e", 100),
    ];
    const all = new Set(pages.map((p) => p.id));
    expect(planPasses(pages, all, 100_000)).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
    expect(planPasses(pages, new Set(["e", "a"]), 100_000)).toEqual([["a", "e"]]);
    // A small file is quicker built at once.
    expect(planPasses(pages, all, 5_000)).toEqual([null]);
    expect(planPasses(pages, new Set(["b"]), 5_000)).toEqual([["b"]]);
    expect(planPasses(pages, all, 5_000, true)).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
  });
});
