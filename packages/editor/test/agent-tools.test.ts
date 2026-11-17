import { getProp, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  EXPORT_IMAGE_FIT,
  MAX_JSX_CHARS,
  runTool,
  ToolFailure,
  type ToolServices,
} from "../src/agent/tools";
import { Editor } from "../src/editor";
import { ExportError } from "../src/export";
import type { PngOptions } from "../src/headless-render";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};
const data = <T>(result: { data: unknown }) => result.data as T;

describe("agent tools", () => {
  it("each has a name, a description for models, a level and a schema", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(["read", "view", "write"]).toContain(tool.level);
    }
  });

  it("render builds a laid-out tree in one undo step, beside what's on the page", async () => {
    const editor = setup();
    editor.createLayer("frame", { x: 0, y: 0, width: 200, height: 200 }, "p");
    const { ids, jsx } = data<{ ids: string[]; jsx: string }>(
      await runTool(editor, "render", {
        jsx: `<Frame name="Card" flex="col" gap={10} p={20}>
          <Text size={20}>Plan</Text>
          <Text size={20}>Your week</Text>
        </Frame>`,
      }),
    );
    const card = ids[0] as string;
    // To the right of the existing board, 100 apart.
    expect(getProp(props(editor, card), "x")).toBe(300);
    // Auto layout settled it: hugging two lines of text, 10 apart, inside 20 of padding.
    const [plan, week] = editor.doc.childIds(card);
    const height = (id: string) => getProp(props(editor, id), "height");
    expect(getProp(props(editor, card), "height")).toBeCloseTo(
      20 + height(plan as string) + 10 + height(week as string) + 20,
      5,
    );
    expect(getProp(props(editor, week as string), "y")).toBeCloseTo(
      20 + height(plan as string) + 10,
      5,
    );
    // It answers with what it built, ids and all, as JSX.
    expect(jsx).toContain(`id="${card}"`);
    // One step: undo takes the whole card away.
    editor.undo();
    expect(editor.doc.get(card)).toBeUndefined();
    expect(editor.doc.get(plan as string)).toBeUndefined();
  });

  it("render replaces a layer in place, where it was and at its index", async () => {
    const editor = setup();
    const a = editor.createLayer("rect", { x: 40, y: 60, width: 10, height: 10 }, "p", {
      name: "A",
    }) as string;
    const b = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      name: "B",
    }) as string;
    const { ids } = data<{ ids: string[] }>(
      await runTool(editor, "render", { jsx: `<Ellipse name="A2" w={20} h={20} />`, replaceId: a }),
    );
    const a2 = ids[0] as string;
    expect(editor.doc.get(a)).toBeUndefined();
    expect(editor.doc.childIds("p")).toEqual([a2, b]);
    expect(getProp(props(editor, a2), "x")).toBe(40);
    expect(getProp(props(editor, a2), "y")).toBe(60);
    // Undoing the call brings the old layer back.
    editor.undo();
    expect(editor.doc.childIds("p")).toEqual([a, b]);
  });

  it("a failing call changes nothing", async () => {
    const editor = setup();
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    await expect(
      runTool(editor, "render", { jsx: `<Frame fill="nope" />`, replaceId: a }),
    ).rejects.toThrow(ToolFailure);
    expect(editor.doc.get(a)).toBeDefined();
    await expect(runTool(editor, "render", { jsx: "" })).rejects.toThrow(/jsx/);
  });

  it("set_props is all or nothing, and says which change was wrong", async () => {
    const editor = setup();
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    const b = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    const before = getProp(props(editor, a), "fills");
    await expect(
      runTool(editor, "set_props", {
        changes: [
          { id: a, props: { fill: "#2563eb" } },
          { id: b, props: { fill: "blue" } },
        ],
      }),
    ).rejects.toThrow(new RegExp(`${b}: fill="blue" isn't a colour`));
    // The valid change wasn't made either.
    expect(getProp(props(editor, a), "fills")).toEqual(before);
    await runTool(editor, "set_props", {
      changes: [
        { id: a, props: { fill: "#2563eb", radius: 4 } },
        { id: b, props: { opacity: 0.5, w: 40 } },
      ],
    });
    expect(getProp(props(editor, a), "fills")).toEqual([{ type: "solid", color: "#2563eb" }]);
    expect(getProp(props(editor, a), "cornerRadius")).toBe(4);
    // Only what was asked: b's height stays.
    expect(getProp(props(editor, b), "width")).toBe(40);
    expect(getProp(props(editor, b), "height")).toBe(10);
    editor.undo();
    expect(getProp(props(editor, a), "fills")).toEqual(before);
  });

  it("moves layers into a frame, refusing to move one inside itself", async () => {
    const editor = setup();
    const frame = editor.createLayer(
      "frame",
      { x: 100, y: 100, width: 200, height: 200 },
      "p",
    ) as string;
    const rect = editor.createLayer(
      "rect",
      { x: 150, y: 150, width: 10, height: 10 },
      "p",
    ) as string;
    await runTool(editor, "move_nodes", { ids: [rect], parentId: frame });
    expect(editor.doc.get(rect)?.parent).toBe(frame);
    // It stays where it was on the canvas.
    expect(getProp(props(editor, rect), "x")).toBe(50);
    await expect(runTool(editor, "move_nodes", { ids: [frame], parentId: frame })).rejects.toThrow(
      /inside itself/,
    );
  });

  it("deletes nothing when any id is unknown", async () => {
    const editor = setup();
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    await expect(runTool(editor, "delete_nodes", { ids: [a, "nope"] })).rejects.toThrow(
      /no layer nope/,
    );
    expect(editor.doc.get(a)).toBeDefined();
  });

  it("sets variable modes and binds tokens, checking ids and types", async () => {
    const editor = setup();
    const theme = editor.createCollection("Theme") as string;
    const dark = editor.addMode(theme, "Dark") as string;
    const surface = editor.createVariable(theme, "surface", "color", "#ffffff") as string;
    editor.setVariableValue(surface, dark, "#111111");
    const frame = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 100, height: 100 },
      "p",
    ) as string;
    const rect = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, frame) as string;
    await runTool(editor, "bind_token", { ids: [rect], key: "fill", variableId: surface });
    await runTool(editor, "set_variable_mode", { ids: [frame], collectionId: theme, modeId: dark });
    expect(getProp(props(editor, rect), "fills")).toEqual([{ type: "solid", color: "#111111" }]);
    await expect(
      runTool(editor, "set_variable_mode", { ids: [rect], collectionId: theme, modeId: dark }),
    ).rejects.toThrow(/only frames and pages/);
    await expect(
      runTool(editor, "bind_token", { ids: [rect], key: "glow", variableId: surface }),
    ).rejects.toThrow(/key/);
  });

  it("export_image asks the engine for the picture, and words what it couldn't draw", async () => {
    const editor = setup();
    const rect = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    await expect(runTool(editor, "export_image", { id: rect })).rejects.toThrow(
      /can't be rendered here/,
    );
    const asked: PngOptions[] = [];
    const services: ToolServices = {
      renderPng: async (_id, options) => {
        asked.push(options);
        return {
          png: new Uint8Array([137, 80, 78, 71]),
          width: 20,
          height: 20,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          scale: 2,
          approximate: ["glass"],
          missingFonts: ["Fraunces 700"],
          missingImages: ["abc"],
        };
      },
    };
    const out = await runTool(editor, "export_image", { id: rect }, services);
    expect(asked[0]).toEqual({ fit: EXPORT_IMAGE_FIT, background: null });
    expect(out.image).toEqual({ mimeType: "image/png", base64: "iVBORw==" });
    expect(out.data).toMatchObject({ id: rect, width: 20, height: 20, scale: 2 });
    expect((out.data as { approximate: string[] }).approximate).toEqual([
      expect.stringContaining("glass"),
      expect.stringContaining("Fraunces 700"),
      expect.stringContaining("1 image(s)"),
    ]);
    await runTool(editor, "export_image", { id: rect, scale: 3, background: "#fff" }, services);
    expect(asked[1]).toEqual({ scale: 3, background: "#fff" });
    // The engine's own refusal (too large, nothing visible) reaches the model as worded.
    const refusing: ToolServices = {
      renderPng: async () => {
        throw new ExportError("That render is too large (9000 × 9000).");
      },
    };
    await expect(runTool(editor, "export_image", { id: rect }, refusing)).rejects.toThrow(
      ToolFailure,
    );
    await expect(runTool(editor, "export_image", { id: "nope" }, services)).rejects.toThrow(
      /no layer nope/,
    );
  });

  it("refuses JSX longer than one read returns, and reads a part of it", async () => {
    const editor = setup();
    // Texts hold at most 200,000 characters: enough of them to pass the bound.
    const long = "x".repeat(200_000);
    const count = Math.ceil(MAX_JSX_CHARS / long.length) + 1;
    editor.doc.apply([
      { op: "create", id: "f", type: "frame", parent: "p", key: "a0", props: {} },
      ...Array.from({ length: count }, (_, i) => ({
        op: "create" as const,
        id: `t${i}`,
        type: "text" as const,
        parent: "f",
        key: `a${String.fromCharCode(65 + i)}`,
        props: { characters: long },
      })),
    ]);
    await expect(runTool(editor, "get_jsx", { id: "f" })).rejects.toThrow(
      /more JSX than one read returns/,
    );
    const one = data<{ jsx: string }>(await runTool(editor, "get_jsx", { id: "t0" }));
    expect(one.jsx.length).toBeGreaterThan(long.length);
  });

  it("checks input against the schema, and refuses to write for a viewer", async () => {
    const editor = setup();
    await expect(runTool(editor, "get_jsx", {})).rejects.toThrow(/id/);
    await expect(runTool(editor, "nope", {})).rejects.toThrow(/no tool called nope/);
    editor.state.set({ role: "viewer" });
    await expect(runTool(editor, "render", { jsx: "<Rect />" })).rejects.toThrow(/view-only/);
  });
});
