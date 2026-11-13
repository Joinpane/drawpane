import { getProp, ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";
import { exportCss, exportDtcg, findVariable, resolveVariable } from "../src/variables";

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
const fillOf = (editor: Editor, id: string) => {
  const fills = getProp(props(editor, id), "fills");
  return fills[0]?.type === "solid" ? fills[0].color : undefined;
};

describe("variables", () => {
  let editor: Editor;
  let colors: string;
  let light: string;
  let dark: string;
  let brand: string;
  let surface: string;
  let space: string;

  beforeEach(() => {
    editor = setup();
    colors = editor.createCollection("Color") as string;
    light = getProp(props(editor, colors), "modes")[0]?.id as string;
    dark = editor.addMode(colors, "Dark") as string;
    brand = editor.createVariable(colors, "brand/500", "color", "#2563eb") as string;
    surface = editor.createVariable(colors, "surface/page", "color", "#ffffff") as string;
    editor.setVariableValue(surface, dark, "#111111");
    const spacing = editor.createCollection("Spacing") as string;
    space = editor.createVariable(spacing, "space/200", "number", 8) as string;
  });

  it("keeps pages and collections apart", () => {
    expect(editor.doc.pageIds()).toEqual(["p"]);
    expect(editor.doc.collectionIds()).toHaveLength(2);
  });

  it("binds a property and writes the resolved value", () => {
    const rect = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    editor.bindVariable([rect], "fill", brand);
    expect(fillOf(editor, rect)).toBe("#2563eb");
    expect(getProp(props(editor, rect), "bindings")).toEqual({ fill: brand });

    // Changing the variable updates every bound layer.
    editor.setVariableValue(brand, light, "#1d4ed8");
    expect(fillOf(editor, rect)).toBe("#1d4ed8");
  });

  it("detaches when a bound property is set by hand", () => {
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 100, height: 100 }, "p", {
      layoutMode: "row",
    }) as string;
    editor.bindVariable([frame], "gap", space);
    expect(props(editor, frame).gap).toBe(8);
    editor.setProp([frame], "gap", 20);
    expect(getProp(props(editor, frame), "bindings")).toEqual({});
    editor.setVariableValue(
      space,
      getProp(props(editor, editor.doc.get(space)?.parent ?? ""), "modes")[0]?.id as string,
      12,
    );
    expect(props(editor, frame).gap).toBe(20);
  });

  it("resolves modes from the nearest frame", () => {
    const board = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 200, height: 200 },
      "p",
    ) as string;
    const card = editor.createLayer(
      "rect",
      { x: 10, y: 10, width: 50, height: 50 },
      board,
    ) as string;
    editor.bindVariable([card], "fill", surface);
    expect(fillOf(editor, card)).toBe("#ffffff");
    editor.setVariableMode(board, colors, dark);
    expect(fillOf(editor, card)).toBe("#111111");
    // Moving the card out of the dark board resolves it in the page's default mode.
    editor.commit(editor.reparentOps(card, "p", editor.topKey("p")));
    expect(fillOf(editor, card)).toBe("#ffffff");
  });

  it("follows aliases and refuses cycles", () => {
    const action = editor.createVariable(colors, "action/primary", "color", {
      alias: brand,
    }) as string;
    expect(resolveVariable(editor.doc, action)).toBe("#2563eb");
    const rect = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    editor.bindVariable([rect], "fill", action);
    editor.setVariableValue(brand, light, "#ff0000");
    expect(fillOf(editor, rect)).toBe("#ff0000");
    editor.setVariableValue(brand, light, { alias: action });
    expect(resolveVariable(editor.doc, action)).toBe("#ff0000");
  });

  it("refuses a variable of the wrong type", () => {
    const rect = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    editor.bindVariable([rect], "cornerRadius", brand);
    expect(getProp(props(editor, rect), "bindings")).toEqual({});
    expect(editor.s.notice?.text).toMatch(/holds a color/);
  });

  it("undoes a variable change on every bound layer", () => {
    const rect = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    editor.bindVariable([rect], "fill", brand);
    editor.setVariableValue(brand, light, "#000000");
    editor.undo();
    expect(fillOf(editor, rect)).toBe("#2563eb");
  });

  it("exports CSS custom properties per mode and DTCG JSON", () => {
    editor.createVariable(colors, "action/primary", "color", { alias: brand });
    const css = exportCss(editor.doc);
    expect(css).toContain(":root {\n  --brand-500: #2563eb;");
    expect(css).toContain('[data-color="dark"] {');
    expect(css).toContain("--surface-page: #111111;");
    expect(css).toContain("--action-primary: var(--brand-500);");
    expect(css).toContain("--space-200: 8px;");

    const dtcg = exportDtcg(editor.doc) as Record<string, Record<string, Record<string, unknown>>>;
    expect(dtcg.brand?.["500"]).toMatchObject({ $type: "color", $value: "#2563eb" });
    expect(dtcg.action?.primary).toMatchObject({ $value: "{brand.500}" });
    expect(dtcg.space?.["200"]).toMatchObject({ $type: "dimension", $value: "8px" });
  });

  it("imports DTCG JSON with groups, aliases and modes", () => {
    const id = editor.importTokens({
      color: {
        $type: "color",
        blue: { 600: { $value: "#2563eb" } },
        action: {
          primary: {
            $value: "{color.blue.600}",
            $extensions: { "drawpane.modes": { Dark: "#60a5fa" } },
          },
        },
      },
      radius: { sm: { $type: "dimension", $value: "0.25rem" } },
    }) as string;
    expect(getProp(props(editor, id), "modes").map((m) => m.name)).toEqual(["Default", "Dark"]);
    const action = findVariable(editor.doc, "color/action/primary") as NonNullable<
      ReturnType<typeof findVariable>
    >;
    expect(resolveVariable(editor.doc, action.id)).toBe("#2563eb");
    expect(resolveVariable(editor.doc, findVariable(editor.doc, "radius/sm")?.id ?? "")).toBe(4);
  });

  it("re-resolves bindings inside instances for their own mode", () => {
    const button = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 80, height: 32 },
      "p",
    ) as string;
    editor.bindVariable([button], "fill", surface);
    editor.select([button]);
    editor.createComponent();
    const darkBoard = editor.createLayer(
      "frame",
      { x: 200, y: 0, width: 300, height: 300 },
      "p",
    ) as string;
    editor.setVariableMode(darkBoard, colors, dark);
    editor.select([darkBoard]);
    const instance = editor.insertInstance(button) as string;
    expect(fillOf(editor, instance)).toBe("#111111");
    // A change to the main re-syncs the instance, which still resolves in its dark board.
    editor.setProp([button], "cornerRadius", 6);
    expect(fillOf(editor, instance)).toBe("#111111");
    expect(fillOf(editor, button)).toBe("#ffffff");
  });
});
