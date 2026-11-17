/**
 * A component nested in another with its size bound to a variable, the
 * way a slider's thumb is sized per style: 12 x 12 in one mode, 24 x 16 in
 * another. The nested copy's record saves the size it has in the main's
 * mode; a copy of the slider in a frame set to another mode takes that
 * mode's size, unless Figma saved a size for that copy.
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
const alias = (target: Guid) => ({
  value: { alias: { guid: target } },
  dataType: "ALIAS",
  resolvedDataType: "FLOAT",
});
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }];

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
 * The sample with a thumb component, a slider component holding a copy of
 * it whose width and height are bound (Light 12 x 12, Dark 24 x 16), and
 * copies of the slider: in the Light frame, in the Dark frame, and in the
 * Dark frame with a size Figma saved for its thumb (20 x 20).
 */
function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const s = sampleModes(parsed.nodeChanges);
  const page = s.lightFrame.parentIndex?.guid as Guid;
  const [width, height] = [guid(1), guid(2)];
  const thumb = guid(10);
  const slider = guid(11);
  const nested = guid(12);
  const [lightCopy, darkCopy, savedCopy] = [guid(13), guid(14), guid(15)];
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
  const records = [
    number(width, "slider/thumb-width", 12, 24, "~a"),
    number(height, "slider/thumb-height", 12, 16, "~b"),
    {
      guid: thumb,
      phase: "CREATED",
      parentIndex: { guid: page, position: "~y" },
      type: "SYMBOL",
      name: "Thumb",
      visible: true,
      opacity: 1,
      size: { x: 12, y: 12 },
      transform: identity(2000, 2000),
      fillPaints: white,
    },
    {
      guid: slider,
      phase: "CREATED",
      parentIndex: { guid: page, position: "~z" },
      type: "SYMBOL",
      name: "Slider",
      visible: true,
      opacity: 1,
      size: { x: 100, y: 16 },
      transform: identity(2000, 2100),
    },
    {
      guid: nested,
      phase: "CREATED",
      parentIndex: { guid: slider, position: "!" },
      type: "INSTANCE",
      name: "Thumb",
      visible: true,
      opacity: 1,
      size: { x: 12, y: 12 },
      transform: identity(40, 2),
      symbolData: { symbolID: thumb, symbolOverrides: [] },
      variableConsumptionMap: {
        entries: [
          { variableField: "WIDTH", variableData: alias(width) },
          { variableField: "HEIGHT", variableData: alias(height) },
        ],
      },
    },
    ...(
      [
        [lightCopy, s.lightFrame, []],
        [darkCopy, s.darkFrame, []],
        [savedCopy, s.darkFrame, [{ guidPath: { guids: [nested] }, size: { x: 20, y: 20 } }]],
      ] as const
    ).map(([id, frame, derivedSymbolData], i) => ({
      guid: id,
      phase: "CREATED",
      parentIndex: { guid: frame.guid, position: `~z${i}` },
      type: "INSTANCE",
      name: "Slider",
      visible: true,
      opacity: 1,
      size: { x: 100, y: 16 },
      transform: identity(8, 8 + 30 * i),
      symbolData: { symbolID: slider, symbolOverrides: [] },
      derivedSymbolData,
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
    main: key(nested),
    light: key(lightCopy),
    dark: key(darkCopy),
    saved: key(savedCopy),
  };
}

function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

describe("nested copies sized by variables", { timeout: 60_000 }, () => {
  it("take the size of their frame's mode", async () => {
    const f = fixture();
    const fig = await readFig(f.bytes);
    const nodes = [...walk(fig.file.document)];
    const size = (id: string) => nodes.find((n) => n.id === id)?.size;
    const thumbOf = (copy: string) =>
      size(nodes.find((n) => n.id === copy)?.children?.[0]?.id ?? "");
    expect(size(f.main)).toEqual({ x: 12, y: 12 });
    expect(thumbOf(f.light)).toEqual({ x: 12, y: 12 });
    expect(thumbOf(f.dark)).toEqual({ x: 24, y: 16 });
    // A size Figma saved for the copy holds.
    expect(thumbOf(f.saved)).toEqual({ x: 20, y: 20 });
  });
});
