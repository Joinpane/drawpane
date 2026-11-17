/**
 * Copies of a component in frames that set a variable mode, the way design
 * systems layer their tokens: a component binds a token of one collection
 * ("component/card/bg"), and that token aliases a variable of another
 * collection that has the light and dark modes ("background"). A frame set
 * to Dark shows its copies dark, in Figma and in the import. A token can
 * also be a colour of the other collection at an opacity (Figma's
 * `COMPOSE_COLOR`), as translucent overlays and dark surfaces often are.
 *
 * Made by adding records to a committed sample that has a Light and Dark
 * collection and frames set to each (`pattern.fig`). The sample's own
 * schema predates `COMPOSE_COLOR`, so that case is built from the records
 * as read rather than from a saved file.
 */
import { readFileSync } from "node:fs";
import type { Figma } from "@drawpane/figma";
import { materializeDocument, parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import type { SceneGraph, SceneNode } from "@open-pencil/scene-graph";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));

const guid = (localID: number, sessionID = 900) => ({ sessionID, localID });
const key = (g: { sessionID: number; localID: number }) => `${g.sessionID}:${g.localID}`;
const alias = (target: { sessionID: number; localID: number }, type: "COLOR" | "FLOAT") => ({
  value: { alias: { guid: target } },
  dataType: "ALIAS",
  resolvedDataType: type,
});
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

/** The sample's mode collection, its Light and Dark modes, and a frame set to each. */
function sampleModes(records: readonly NodeChange[]) {
  const set = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
    variableSetModes: { id: { sessionID: number; localID: number }; name: string }[];
  };
  const mode = (name: string) => {
    const found = set.variableSetModes.find((m) => m.name.startsWith(name));
    if (!found) throw new Error(`no ${name} mode`);
    return found.id;
  };
  const light = mode("Light");
  const dark = mode("Dark");
  const variable = (name: string) =>
    records.find((r) => r.type === "VARIABLE" && r.name === name)?.guid;
  const background = variable("Colors/Background");
  const foreground = variable("Colors/Foreground");
  const frameIn = (m: { sessionID: number; localID: number }) =>
    records.find(
      (r) =>
        r.type === "FRAME" &&
        (
          r.variableModeBySetMap as
            | { entries?: { variableModeID?: { sessionID: number; localID: number } }[] }
            | undefined
        )?.entries?.some((e) => e.variableModeID && key(e.variableModeID) === key(m)),
    );
  const lightFrame = frameIn(light);
  const darkFrame = frameIn(dark);
  if (!background || !foreground || !lightFrame?.guid || !darkFrame?.guid)
    throw new Error("the sample changed");
  return {
    set: set.guid as NonNullable<NodeChange["guid"]>,
    variablesParent: set.parentIndex?.guid as NonNullable<NodeChange["guid"]>,
    light,
    dark,
    background,
    foreground,
    lightFrame,
    darkFrame,
  };
}

/**
 * The sample's records with a token collection aliasing its modes, a card
 * bound to it, and a copy of the card in a frame set to Light and one in a
 * frame set to Dark. The card's overlay is the other collection's
 * foreground: at 40% when `composed`, else as it is.
 */
function withTokens(composed: boolean) {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const s = sampleModes(parsed.nodeChanges);
  const page = s.lightFrame.parentIndex?.guid as NonNullable<NodeChange["guid"]>;

  const tokens = guid(1);
  const tokenMode = guid(2);
  const radius = guid(3);
  const bg = guid(4);
  const cardRadius = guid(5);
  const veil = guid(6);
  const card = guid(10);
  const surface = guid(11);
  const overlay = guid(14);
  const lightCopy = guid(12);
  const darkCopy = guid(13);

  const records = [
    // A number with a value per mode, in the sample's own collection.
    {
      guid: radius,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~a" },
      type: "VARIABLE",
      name: "Radius/Card",
      variableSetID: { guid: s.set },
      variableResolvedType: "FLOAT",
      variableDataValues: {
        entries: [
          { modeID: s.light, variableData: { value: { floatValue: 2 }, dataType: "FLOAT" } },
          { modeID: s.dark, variableData: { value: { floatValue: 12 }, dataType: "FLOAT" } },
        ],
      },
    },
    // A second collection, one mode, whose tokens alias the first's variables.
    {
      guid: tokens,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~b" },
      type: "VARIABLE_SET",
      name: "Tokens",
      variableSetModes: [{ id: tokenMode, name: "Default", sortPosition: "!" }],
    },
    {
      guid: bg,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~c" },
      type: "VARIABLE",
      name: "component/card/bg",
      variableSetID: { guid: tokens },
      variableResolvedType: "COLOR",
      variableDataValues: {
        entries: [{ modeID: tokenMode, variableData: alias(s.background, "COLOR") }],
      },
    },
    {
      guid: cardRadius,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~d" },
      type: "VARIABLE",
      name: "component/card/radius",
      variableSetID: { guid: tokens },
      variableResolvedType: "FLOAT",
      variableDataValues: {
        entries: [{ modeID: tokenMode, variableData: alias(radius, "FLOAT") }],
      },
    },
    {
      guid: veil,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~e" },
      type: "VARIABLE",
      name: "component/card/veil",
      variableSetID: { guid: tokens },
      variableResolvedType: "COLOR",
      variableDataValues: {
        entries: [
          {
            modeID: tokenMode,
            variableData: composed
              ? {
                  dataType: "EXPRESSION",
                  resolvedDataType: "COLOR",
                  value: {
                    expressionValue: {
                      expressionFunction: "COMPOSE_COLOR",
                      expressionArguments: [
                        alias(s.foreground, "COLOR"),
                        { dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: 40 } },
                      ],
                    },
                  },
                }
              : alias(s.foreground, "COLOR"),
          },
        ],
      },
    },
    // The card: a component whose surface binds the tokens, saved as it shows in Light.
    {
      guid: card,
      phase: "CREATED",
      parentIndex: { guid: page, position: "~z" },
      type: "SYMBOL",
      name: "Card",
      visible: true,
      opacity: 1,
      size: { x: 40, y: 40 },
      transform: identity(2000, 2000),
    },
    {
      guid: surface,
      phase: "CREATED",
      parentIndex: { guid: card, position: "!" },
      type: "ROUNDED_RECTANGLE",
      name: "Surface",
      visible: true,
      opacity: 1,
      size: { x: 40, y: 40 },
      transform: identity(),
      cornerRadius: 2,
      fillPaints: [
        {
          type: "SOLID",
          color: { r: 1, g: 0.98, b: 0.98, a: 1 },
          opacity: 1,
          visible: true,
          blendMode: "NORMAL",
          colorVar: alias(bg, "COLOR"),
        },
      ],
      variableConsumptionMap: {
        entries: [{ variableField: "CORNER_RADIUS", variableData: alias(cardRadius, "FLOAT") }],
      },
    },
    {
      guid: overlay,
      phase: "CREATED",
      parentIndex: { guid: card, position: "#" },
      type: "ROUNDED_RECTANGLE",
      name: "Overlay",
      visible: true,
      opacity: 1,
      size: { x: 20, y: 20 },
      transform: identity(10, 10),
      fillPaints: [
        {
          type: "SOLID",
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true,
          blendMode: "NORMAL",
          colorVar: alias(veil, "COLOR"),
        },
      ],
    },
    // A copy in the frame set to Light, and one in the frame set to Dark.
    ...[
      [lightCopy, s.lightFrame],
      [darkCopy, s.darkFrame],
    ].map(([id, frame]) => ({
      guid: id,
      phase: "CREATED",
      parentIndex: { guid: (frame as NodeChange).guid, position: "~z" },
      type: "INSTANCE",
      name: "Card",
      visible: true,
      opacity: 1,
      size: { x: 40, y: 40 },
      transform: identity(8, 8),
      symbolData: { symbolID: card, symbolOverrides: [] },
    })),
  ] as unknown as NodeChange[];
  return { parsed, records, s, light: key(lightCopy), dark: key(darkCopy) };
}

/** The sample saved with the tokens and the card added. */
function savedWithTokens() {
  const { parsed, records, light, dark } = withTokens(false);
  const patched = patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
  return { bytes: patched, light, dark };
}

function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

const hex = (c: { r: number; g: number; b: number } | undefined) =>
  c
    ? `#${[c.r, c.g, c.b]
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : undefined;

describe("variable modes", { timeout: 60_000 }, () => {
  it("draws a copy in a frame's mode through tokens aliased from another collection", async () => {
    const fixture = savedWithTokens();
    const fig = await readFig(fixture.bytes);
    const nodes = [...walk(fig.file.document)];
    const layers = (copy: string) => {
      const instance = nodes.find((n) => n.id === copy);
      const [surface, overlay] = instance?.children ?? [];
      if (!surface || !overlay) throw new Error(`no copy ${copy}`);
      const paint = (layer: Figma.Node) => {
        const fill = layer.fills?.[0];
        return {
          color: hex(fill && "color" in fill ? fill.color : undefined),
          opacity: fill?.opacity ?? 1,
        };
      };
      return {
        surface: { ...paint(surface), radius: surface.cornerRadius },
        overlay: paint(overlay),
      };
    };
    // The sample's Colors/Background is #fffafa in Light and #353839 in Dark; Foreground the reverse.
    expect(layers(fixture.light)).toEqual({
      surface: { color: "#fffafa", opacity: 1, radius: 2 },
      overlay: { color: "#353839", opacity: 1 },
    });
    expect(layers(fixture.dark)).toEqual({
      surface: { color: "#353839", opacity: 1, radius: 12 },
      overlay: { color: "#fffafa", opacity: 1 },
    });
  });

  it("composes a colour at an opacity in the copy's mode", () => {
    const { parsed, records, s } = withTokens(true);
    const noop = () => {};
    const { graph } = materializeDocument([...parsed.nodeChanges, ...records], parsed.blobs, {
      onUnresolvedProperty: noop,
      onUnresolvedAssignment: noop,
      onMissingSlotContent: noop,
      onMissingComponent: noop,
      onUnresolvedBinding: noop,
      onUnsupportedResource: noop,
    });
    const overlayIn = (frame: NodeChange) => {
      const child = (parent: SceneNode | undefined, name: string) =>
        parent?.childIds.map((id) => graph.getNode(id)).find((n) => n?.name === name);
      const placed = [...(graph as SceneGraph).getAllNodes()].find(
        (n) => n.name === frame.name && n.type === "FRAME" && child(n, "Card"),
      );
      const fill = child(child(placed, "Card"), "Overlay")?.fills[0];
      return fill && { color: hex(fill.color), opacity: fill.opacity };
    };
    expect(overlayIn(s.lightFrame)).toEqual({ color: "#353839", opacity: 0.4 });
    expect(overlayIn(s.darkFrame)).toEqual({ color: "#fffafa", opacity: 0.4 });
  });
});
