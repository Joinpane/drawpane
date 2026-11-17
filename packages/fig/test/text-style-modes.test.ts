/**
 * Text styles whose size, line height and letter spacing are bound to
 * variables, used by copies in frames set to different modes: the way a
 * design system ships a compact style (12 px text where the default is 14)
 * as a mode of one collection. Figma draws each copy's text at its mode's
 * values; the layer and the style save only the default's.
 *
 * Made by adding records to a committed sample that has a Light and Dark
 * collection and frames set to each (`pattern.fig`).
 */
import { readFileSync } from "node:fs";
import type { Figma } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));

type Guid = { sessionID: number; localID: number };
const guid = (localID: number, sessionID = 900): Guid => ({ sessionID, localID });
const key = (g: Guid) => `${g.sessionID}:${g.localID}`;
const UNSET = guid(0xffffffff, 0xffffffff);
const alias = (target: Guid) => ({
  value: { alias: { guid: target } },
  dataType: "ALIAS",
  resolvedDataType: "FLOAT",
});
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const px = (value: number) => ({ value, units: "PIXELS" });

/** The sample's mode collection, its Light and Dark modes, and a frame set to each. */
function sampleModes(records: readonly NodeChange[]) {
  const set = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
    variableSetModes: { id: Guid; name: string }[];
  };
  const mode = (name: string) => {
    const found = set.variableSetModes.find((m) => m.name.startsWith(name));
    if (!found) throw new Error(`no ${name} mode`);
    return found.id;
  };
  const light = mode("Light");
  const dark = mode("Dark");
  const frameIn = (m: Guid) =>
    records.find(
      (r) =>
        r.type === "FRAME" &&
        (
          r.variableModeBySetMap as { entries?: { variableModeID?: Guid }[] } | undefined
        )?.entries?.some((e) => e.variableModeID && key(e.variableModeID) === key(m)),
    );
  const lightFrame = frameIn(light);
  const darkFrame = frameIn(dark);
  if (!lightFrame?.guid || !darkFrame?.guid) throw new Error("the sample changed");
  return {
    set: set.guid as Guid,
    variablesParent: set.parentIndex?.guid as Guid,
    light,
    dark,
    lightFrame,
    darkFrame,
  };
}

/**
 * The sample with a text style bound to three variables (Light 14/20/0,
 * Dark 12/16/1), a label component whose text uses it, and copies of the
 * label: one in the Light frame, one in the Dark frame, and one in the Dark
 * frame that takes its text off the style (18 px on 24, as Figma saves a
 * detached override).
 */
function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const s = sampleModes(parsed.nodeChanges);
  const page = s.lightFrame.parentIndex?.guid as Guid;
  const [size, height, tracking] = [guid(1), guid(2), guid(3)];
  const style = guid(4);
  const label = guid(10);
  const text = guid(11);
  const [lightCopy, darkCopy, detachedCopy] = [guid(12), guid(13), guid(14)];

  const number = (id: Guid, name: string, light: number, dark: number, position: string) => ({
    guid: id,
    phase: "CREATED",
    parentIndex: { guid: s.variablesParent, position },
    type: "VARIABLE",
    name,
    variableSetID: { guid: s.set },
    variableResolvedType: "FLOAT",
    variableDataValues: {
      entries: [
        { modeID: s.light, variableData: { value: { floatValue: light }, dataType: "FLOAT" } },
        { modeID: s.dark, variableData: { value: { floatValue: dark }, dataType: "FLOAT" } },
      ],
    },
  });
  const textFields = {
    fontSize: 14,
    lineHeight: px(20),
    letterSpacing: px(0),
    fontName: { family: "Inter", style: "Medium", postscript: "Inter-Medium" },
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
  };
  const records = [
    number(size, "text/sm/size", 14, 12, "~a"),
    number(height, "text/sm/lh", 20, 16, "~b"),
    number(tracking, "text/sm/tracking", 0, 1, "~c"),
    {
      guid: style,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~d" },
      type: "TEXT",
      name: "component/label",
      styleType: "TEXT",
      ...textFields,
      textData: { characters: "Ag" },
      variableConsumptionMap: {
        entries: [
          { variableField: "FONT_SIZE", variableData: alias(size) },
          { variableField: "LINE_HEIGHT", variableData: alias(height) },
          { variableField: "LETTER_SPACING", variableData: alias(tracking) },
        ],
      },
    },
    {
      guid: label,
      phase: "CREATED",
      parentIndex: { guid: page, position: "~z" },
      type: "SYMBOL",
      name: "Label",
      visible: true,
      opacity: 1,
      size: { x: 80, y: 20 },
      transform: identity(2000, 2000),
    },
    {
      guid: text,
      phase: "CREATED",
      parentIndex: { guid: label, position: "!" },
      type: "TEXT",
      name: "Text",
      visible: true,
      opacity: 1,
      size: { x: 80, y: 20 },
      transform: identity(),
      ...textFields,
      styleIdForText: { guid: style },
      textData: { characters: "Alert Dialog" },
      fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
    },
    ...(
      [
        [lightCopy, s.lightFrame, []],
        [darkCopy, s.darkFrame, []],
        [
          detachedCopy,
          s.darkFrame,
          [
            {
              guidPath: { guids: [text] },
              styleIdForText: { guid: UNSET },
              fontSize: 18,
              lineHeight: px(24),
              letterSpacing: px(0),
            },
          ],
        ],
      ] as const
    ).map(([id, frame, symbolOverrides], i) => ({
      guid: id,
      phase: "CREATED",
      parentIndex: { guid: frame.guid, position: `~z${i}` },
      type: "INSTANCE",
      name: "Label",
      visible: true,
      opacity: 1,
      size: { x: 80, y: 20 },
      transform: identity(8, 8 + 30 * i),
      symbolData: { symbolID: label, symbolOverrides },
    })),
  ] as unknown as NodeChange[];

  const saved = patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
  return {
    bytes: saved,
    light: key(lightCopy),
    dark: key(darkCopy),
    detached: key(detachedCopy),
  };
}

function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

describe("text styles bound to variables", { timeout: 60_000 }, () => {
  it("draw a copy's text at its frame's mode", async () => {
    const f = fixture();
    const fig = await readFig(f.bytes);
    const nodes = [...walk(fig.file.document)];
    const textOf = (copy: string) => {
      const label = nodes.find((n) => n.id === copy)?.children?.[0];
      if (!label?.style) throw new Error(`no copy ${copy}`);
      const { fontSize, lineHeightPx, letterSpacing } = label.style;
      return { fontSize, lineHeightPx, letterSpacing };
    };
    expect(textOf(f.light)).toEqual({ fontSize: 14, lineHeightPx: 20, letterSpacing: 0 });
    expect(textOf(f.dark)).toEqual({ fontSize: 12, lineHeightPx: 16, letterSpacing: 1 });
    // A copy that took its text off the style keeps what it set, in any mode.
    expect(textOf(f.detached)).toEqual({ fontSize: 18, lineHeightPx: 24, letterSpacing: 0 });
  });
});
