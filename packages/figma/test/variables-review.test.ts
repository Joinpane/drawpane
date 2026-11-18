/**
 * Variables and styles from Figma's REST shape against #186's review
 * (decision 0034): a themed copy keeps the value Figma saved for it (F12)
 * without becoming an override when copies are compact, a text style keeps
 * its typography's bindings (F13), and a bound colour's alpha, which Figma
 * saves as the paint's opacity too, is folded into the colour once.
 */
import {
  CopyView,
  compactByInstance,
  MemoryStore,
  type NodeRecord,
  type Paint,
  TokenResolver,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { convertFile, drawpaneId, type Figma } from "../src";

const alias = { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } as const;
const variables = {
  variableCollections: {
    "VariableCollectionId:1:0": {
      id: "VariableCollectionId:1:0",
      name: "Theme",
      modes: [
        { modeId: "1:2", name: "Light" },
        { modeId: "1:3", name: "Dark" },
      ],
      defaultModeId: "1:2",
      variableIds: [alias.id],
    },
  },
  variables: {
    [alias.id]: {
      id: alias.id,
      name: "bg",
      variableCollectionId: "VariableCollectionId:1:0",
      resolvedType: "COLOR",
      valuesByMode: { "1:2": { r: 1, g: 1, b: 1, a: 1 }, "1:3": { r: 0, g: 0, b: 0, a: 0.5 } },
    },
  },
};
const rect = (id: string, c: number, opacity?: number) => ({
  id,
  name: id,
  type: "RECTANGLE",
  size: { x: 20, y: 20 },
  relativeTransform: [
    [1, 0, 0],
    [0, 1, 0],
  ],
  fills: [
    {
      type: "SOLID",
      color: { r: c, g: c, b: c, a: 1 },
      ...(opacity === undefined ? {} : { opacity }),
      boundVariables: { color: alias },
    },
  ],
});
const themed = () =>
  ({
    name: "Review",
    variables,
    components: { "2:0": { name: "Card" } },
    document: {
      id: "0:0",
      name: "doc",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          name: "Page",
          type: "CANVAS",
          children: [
            {
              id: "2:0",
              name: "Card",
              type: "COMPONENT",
              size: { x: 20, y: 20 },
              children: [rect("2:1", 1)],
            },
            {
              id: "3:0",
              name: "Copy",
              type: "INSTANCE",
              componentId: "2:0",
              size: { x: 20, y: 20 },
              explicitVariableModes: { "VariableCollectionId:1:0": "1:3" },
              // Figma saves the Dark variable's alpha as the paint's opacity.
              children: [rect("I3:0;2:1", 0, 0.5)],
            },
          ],
        },
      ],
    },
  }) as unknown as Figma.File;

const fillOf = (node: NodeRecord | undefined) => (node?.props.fills as Paint[] | undefined)?.[0];

describe("saved values of themed copies (F12)", () => {
  it("F12: the materialized result keeps the copy's saved value, not marked overridden", () => {
    const { nodes } = convertFile(themed());
    const copy = nodes.find((n) => n.id === drawpaneId("I3:0;2:1"));
    expect(fillOf(copy)).toMatchObject({ type: "solid", color: "#00000080" });
    expect(copy?.props.overrides ?? []).not.toContain("fills");
  });

  it("F12: compact copies don't pin it as an override, and resolve it where the copy is", () => {
    const { nodes } = convertFile(themed());
    const compact = compactByInstance(nodes).nodes;
    // Converted: its layer is a copy now, not stored.
    expect(compact.some((n) => n.id === drawpaneId("I3:0;2:1"))).toBe(false);
    const record = compact.find((n) => n.type === "override");
    expect(record?.props.fills).toBeUndefined();
    const view = new CopyView(new MemoryStore(compact));
    const resolver = new TokenResolver(view);
    const layer = view.childIds(drawpaneId("3:0"))[0] as string;
    expect(fillOf(resolver.resolve(view.get(layer) as NodeRecord))).toMatchObject({
      color: "#00000080",
    });
  });
});

describe("alpha normalised at import", () => {
  it("a bound colour's saved opacity is folded into its colour; the paint keeps none", () => {
    const { nodes } = convertFile(themed());
    const main = nodes.find((n) => n.id === drawpaneId("2:1"));
    expect(fillOf(main)).toEqual({
      type: "solid",
      color: "#ffffff",
      bind: { color: drawpaneId(alias.id) },
    });
    const copy = fillOf(nodes.find((n) => n.id === drawpaneId("I3:0;2:1")));
    expect(copy?.opacity).toBeUndefined();
  });
});

describe("text styles (F13)", () => {
  it("F13: a variable-bound text style keeps its fontSize binding", () => {
    const variable = {
      ...variables.variables[alias.id],
      resolvedType: "FLOAT",
      valuesByMode: { "1:2": 12, "1:3": 24 },
    };
    const file = {
      name: "Review",
      variables: { ...variables, variables: { [alias.id]: variable } },
      styles: { "4:0": { name: "Body", styleType: "TEXT" } },
      styleNodes: {
        "4:0": {
          id: "4:0",
          name: "Body",
          type: "TEXT",
          style: { fontFamily: "Arial", fontSize: 12 },
          boundVariables: { fontSize: alias },
        },
      },
      document: {
        id: "0:0",
        name: "doc",
        type: "DOCUMENT",
        children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [] }],
      },
    } as unknown as Figma.File;
    const style = convertFile(file).nodes.find((n) => n.id === drawpaneId("4:0"));
    expect(style?.type).toBe("textStyle");
    expect(style?.props.bindings).toEqual({ fontSize: drawpaneId(alias.id) });
    expect(style?.props.fontSize).toBe(12);
  });
});

describe("bindings say how they read (decision 0034)", () => {
  it("an imported opacity binding reads its variable as a percentage, text bound to a number as text", () => {
    const number = { type: "VARIABLE_ALIAS", id: "VariableID:5:1" } as const;
    const file = {
      name: "Units",
      variables: {
        variableCollections: {
          "VariableCollectionId:5:0": {
            id: "VariableCollectionId:5:0",
            name: "Numbers",
            modes: [{ modeId: "5:2", name: "Default" }],
            defaultModeId: "5:2",
            variableIds: [number.id],
          },
        },
        variables: {
          [number.id]: {
            id: number.id,
            name: "n",
            variableCollectionId: "VariableCollectionId:5:0",
            resolvedType: "FLOAT",
            valuesByMode: { "5:2": 40 },
          },
        },
      },
      document: {
        id: "0:0",
        name: "doc",
        type: "DOCUMENT",
        children: [
          {
            id: "0:1",
            name: "Page",
            type: "CANVAS",
            children: [
              {
                ...rect("6:1", 1),
                opacity: 0.4,
                fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
                boundVariables: { opacity: number },
              },
              {
                id: "6:2",
                name: "Count",
                type: "TEXT",
                characters: "40",
                size: { x: 20, y: 20 },
                relativeTransform: [
                  [1, 0, 0],
                  [0, 1, 0],
                ],
                style: { fontFamily: "Inter", fontSize: 12 },
                boundVariables: { characters: number },
              },
            ],
          },
        ],
      },
    } as unknown as Figma.File;
    const { nodes } = convertFile(file);
    const variable = drawpaneId(number.id);
    expect(nodes.find((n) => n.id === drawpaneId("6:1"))?.props.bindings).toEqual({
      opacity: { variable, unit: "percent" },
    });
    expect(nodes.find((n) => n.id === drawpaneId("6:2"))?.props.bindings).toEqual({
      characters: { variable, unit: "text" },
    });
  });
});
