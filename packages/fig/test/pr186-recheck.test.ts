/**
 * Variables and styles from a .fig against #186's review (decision 0034):
 * an unused text style keeps its variable-bound typography (F13), and a
 * nested instance swapped to another variant takes the binding of the
 * variant chosen, by provenance rather than by matching colours (F14).
 *
 * The text style is a record added to a committed sample with a Light and
 * Dark collection (`pattern.fig`), as variables-styles.test.ts does.
 */
import { readFileSync } from "node:fs";
import { convertFile, drawpaneId, type Figma } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { SceneGraph, type SceneNode } from "@open-pencil/scene-graph";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";
import { applySwappedLooks } from "../src/swaps";
import { paintColor } from "../src/tokens";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));

type Guid = { sessionID: number; localID: number };
const guid = (localID: number): Guid => ({ sessionID: 902, localID });
const key = (g: Guid) => `${g.sessionID}:${g.localID}`;

describe("text styles from a .fig (F13)", { timeout: 60_000 }, () => {
  it("F13: an unused text style keeps its typography's variable bindings", async () => {
    const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
    const records = parsed.nodeChanges;
    const set = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
      variableSetModes: { id: Guid; name: string }[];
    };
    const internal = set.parentIndex?.guid as Guid;
    const modes = set.variableSetModes.map((m) => m.id);
    const size = guid(1);
    const style = guid(2);
    const added = [
      {
        guid: size,
        phase: "CREATED",
        parentIndex: { guid: internal, position: "~a" },
        type: "VARIABLE",
        name: "Type/Body",
        variableSetID: { guid: set.guid },
        variableResolvedType: "FLOAT",
        variableDataValues: {
          entries: modes.map((modeID, i) => ({
            modeID,
            variableData: { value: { floatValue: 18 + 10 * i }, dataType: "FLOAT" },
          })),
        },
      },
      {
        guid: style,
        phase: "CREATED",
        parentIndex: { guid: internal, position: "~b" },
        type: "TEXT",
        name: "body",
        styleType: "TEXT",
        isPublishable: true,
        visible: true,
        opacity: 1,
        size: { x: 100, y: 20 },
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        fontName: { family: "Inter", style: "Regular", postscript: "" },
        fontSize: 18,
        variableConsumptionMap: {
          entries: [
            {
              variableField: "FONT_SIZE",
              variableData: {
                value: { alias: { guid: size } },
                dataType: "ALIAS",
                resolvedDataType: "FLOAT",
              },
            },
          ],
        },
      },
    ] as unknown as NodeChange[];
    const saved = patchFigArchive(
      bytes.slice().buffer as ArrayBuffer,
      { records: added, fields: [], blobs: [], removed: [], replaceVariables: false },
      {
        thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
        metaJSON: parsed.metaJSON ?? "{}",
        images: [],
      },
    );
    const fig = await readFig(saved);
    const { nodes } = convertFile(fig.file as Figma.File);
    const node = nodes.find((n) => n.id === drawpaneId(key(style)));
    expect(node?.type).toBe("textStyle");
    expect(node?.props.fontSize).toBe(18);
    expect(node?.props.bindings).toEqual({ fontSize: drawpaneId(`VariableID:${key(size)}`) });
  });
});

describe("swapped variants (F14)", () => {
  function swapped(oldBinding: string | null, oldColor: number, ownColor = oldColor) {
    const graph = new SceneGraph();
    const page = graph.getPages(true)[0] as SceneNode;
    graph.variableCollections.set("c", {
      id: "c",
      name: "Theme",
      defaultModeId: "light",
      modes: [{ modeId: "light", name: "Light" }],
      variableIds: ["v", "w"],
    } as never);
    graph.variables.set("v", {
      id: "v",
      name: "Old",
      type: "COLOR",
      collectionId: "c",
      valuesByMode: { light: { r: oldColor, g: oldColor, b: oldColor, a: 1 } },
    } as never);
    graph.variables.set("w", {
      id: "w",
      name: "New",
      type: "COLOR",
      collectionId: "c",
      valuesByMode: { light: { r: 0, g: 0, b: 0, a: 1 } },
    } as never);
    const solid = (c: number) => [
      {
        type: "SOLID",
        color: { r: c, g: c, b: c, a: 1 },
        opacity: 1,
        visible: true,
        blendMode: "NORMAL",
      },
    ];
    const old = graph.createNode("COMPONENT", page.id, {
      strokes: solid(oldColor),
      boundVariables: { "strokes/0/color": "v" },
    } as never);
    const current = graph.createNode("COMPONENT", page.id, {
      strokes: solid(0),
      boundVariables: { "strokes/0/color": "w" },
    } as never);
    const copy = graph.createNode("INSTANCE", page.id, {
      componentId: current.id,
      strokes: solid(ownColor),
      boundVariables: oldBinding ? { "strokes/0/color": oldBinding } : {},
    } as never);
    const guids = new Map([
      [old.id, "1:1"],
      [current.id, "1:2"],
      [copy.id, "9:9"],
    ]);
    const ids = { sourceGuid: (n: SceneNode) => guids.get(n.id) } as never;
    const records = new Map([["9:9", { symbolData: { symbolID: { sessionID: 1, localID: 1 } } }]]);
    applySwappedLooks(
      graph,
      ids,
      records as never,
      new Map([
        ["1:1", old.id],
        ["1:2", current.id],
      ]),
    );
    const after = graph.getNode(copy.id) as SceneNode;
    const aliasOf = (id: unknown) => ({ type: "VARIABLE_ALIAS" as const, id: `VariableID:${id}` });
    return { after, color: paintColor(after, "strokes", 0, aliasOf, graph) };
  }

  it("F14: a swapped variant inherits the chosen variant's colour binding", () => {
    const { after, color } = swapped("v", 1);
    expect(after.strokes[0]?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(color).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:w" });
  });

  it("F14: it does when the old and new variables happen to give the same colour", () => {
    // V equals W in the imported mode: the first mode alone can't tell them apart.
    const { color } = swapped("v", 0);
    expect(color).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:w" });
  });

  it("F14: an instance whose copy of the binding Open Pencil left out still takes the new look", () => {
    const { after, color } = swapped(null, 1);
    expect(after.strokes[0]?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(color).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:w" });
  });

  it("F14: a copy bound to another variable than its old component, its value the same, takes the new look", () => {
    // The kit's dropdown buttons, swapped to the ghost variant: the main holding them binds
    // their fill to another variable than the button component does. They kept the old fill.
    const { after, color } = swapped("x", 1);
    expect(after.strokes[0]?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(color).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:w" });
  });

  it("F14: an instance whose value differs from its old component's overrides it: value and binding kept", () => {
    const { after, color } = swapped("x", 1, 0.5);
    expect(after.strokes[0]?.color).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    expect(color).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:x" });
  });
});
