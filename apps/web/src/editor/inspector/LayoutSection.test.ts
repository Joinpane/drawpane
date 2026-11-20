import { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { IconButton, Switch } from "@drawpane/ui";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Num, Select } from "./fields";
import { AutoLayoutSection } from "./LayoutSection";

const page: NodeRecord = { id: "page", type: "page", parent: ROOT_ID, key: "a0", props: {} };
const frames: NodeRecord[] = [
  {
    id: "included",
    type: "frame",
    parent: "page",
    key: "a0",
    props: {
      layoutMode: "row",
      width: 100,
      height: 50,
      strokeWeight: 5,
      strokes: [{ type: "solid", color: "#000000" }],
      strokeAlign: "inside",
      strokesIncludedInLayout: true,
    },
  },
  {
    id: "excluded",
    type: "frame",
    parent: "page",
    key: "a1",
    props: { layoutMode: "row", width: 100, height: 50 },
  },
  { id: "column", type: "frame", parent: "page", key: "a2", props: { layoutMode: "column" } },
  { id: "grid", type: "frame", parent: "page", key: "a3", props: { layoutMode: "grid" } },
  { id: "plain", type: "frame", parent: "page", key: "a4", props: {} },
];
const child: NodeRecord = {
  id: "fill",
  type: "rect",
  parent: "included",
  key: "a0",
  props: { sizingH: "fill", x: 5, y: 5, width: 90, height: 20 },
};

function setup() {
  const editor = new Editor({
    clientId: "test",
    measurer: { width: (_font, text) => text.length * 8 },
  });
  editor.doc.resetStored([page, ...frames, child], "materialized");
  editor.state.set({ role: "editor" });
  editor.setPage("page");
  return editor;
}

function sectionTree(editor: Editor, ids: string[]) {
  const nodes = ids.map((id) => editor.doc.get(id) as NodeRecord);
  return AutoLayoutSection({ editor, nodes });
}

function findElement(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (predicate(el)) return el;
  return findElement(el.props.children as ReactNode, predicate);
}

function strokesSelect(tree: ReactNode) {
  return findElement(tree, (el) => el.type === Select && el.props.label === "Strokes in layout");
}

function selectedOptionLabel(
  selectEl: ReactElement<Record<string, unknown>> | null,
): string | null {
  if (!selectEl) return null;
  const html = renderToStaticMarkup(selectEl);
  const optMatch = html.match(/<option[^>]*selected=""[^>]*>([^<]*)<\/option>/);
  return optMatch?.[1] ?? null;
}

describe("AutoLayoutSection", () => {
  it("shows Strokes in layout on auto layout frames and hides it on plain or mixed plain selections", () => {
    const editor = setup();
    expect(strokesSelect(sectionTree(editor, ["plain"]))).toBeNull();
    expect(strokesSelect(sectionTree(editor, ["included", "plain"]))).toBeNull();
    expect(selectedOptionLabel(strokesSelect(sectionTree(editor, ["included"])))).toBe(
      "Included in layout",
    );
    expect(selectedOptionLabel(strokesSelect(sectionTree(editor, ["column"])))).toBe(
      "Excluded from layout",
    );
  });

  it("renders Mixed for opposite values and undoes the change and its layout in one step", () => {
    const editor = setup();
    const select = strokesSelect(sectionTree(editor, ["included", "excluded"]));
    expect(selectedOptionLabel(select)).toBe("Mixed");
    if (!select) return;
    (select.props.onChange as (value: string) => void)("excluded");

    expect(getProp(editor.doc.get("included")?.props ?? {}, "strokesIncludedInLayout")).toBe(false);
    expect(editor.doc.get("fill")?.props.width).toBe(100);

    editor.undo();
    expect(getProp(editor.doc.get("included")?.props ?? {}, "strokesIncludedInLayout")).toBe(true);
    expect(editor.doc.get("fill")?.props.width).toBe(90);
    expect(selectedOptionLabel(strokesSelect(sectionTree(editor, ["included", "excluded"])))).toBe(
      "Mixed",
    );
  });

  it("keeps shared auto layout controls and Strokes in layout visible across mixed directions", () => {
    const editor = setup();
    const rowAndCol = sectionTree(editor, ["included", "column"]);
    expect(selectedOptionLabel(strokesSelect(rowAndCol))).toBe("Mixed");
    expect(findElement(rowAndCol, (el) => el.props["aria-label"] === "Alignment")).toBeNull();
    expect(
      findElement(rowAndCol, (el) => el.type === Num && el.props.prop === "paddingLeft"),
    ).not.toBeNull();
    const mainGap = findElement(rowAndCol, (el) => el.type === Num && el.props.prop === "gap");
    expect(mainGap?.props.icon).toBeUndefined();
    expect(mainGap?.props.label).toBe("Gap");
    expect(mainGap?.props.ariaLabel).toBe("Gap between items");
    expect(
      findElement(rowAndCol, (el) => el.type === IconButton && el.props.label === "Wrap"),
    ).not.toBeNull();
    expect(
      findElement(rowAndCol, (el) => el.type === Switch && el.props.label === "Space between"),
    ).not.toBeNull();

    const rowAndGrid = sectionTree(editor, ["included", "grid"]);
    expect(selectedOptionLabel(strokesSelect(rowAndGrid))).toBe("Mixed");
    expect(findElement(rowAndGrid, (el) => el.props["aria-label"] === "Alignment")).toBeNull();
    expect(findElement(rowAndGrid, (el) => el.type === Num && el.props.prop === "gap")).toBeNull();
    expect(
      findElement(rowAndGrid, (el) => el.type === Num && el.props.prop === "rowGap"),
    ).toBeNull();
    expect(
      findElement(rowAndGrid, (el) => el.type === IconButton && el.props.label === "Wrap"),
    ).toBeNull();
    expect(
      findElement(rowAndGrid, (el) => el.type === Switch && el.props.label === "Space between"),
    ).toBeNull();
    expect(
      findElement(rowAndGrid, (el) => el.type === Switch && el.props.label === "Fill their cells"),
    ).toBeNull();
    expect(
      findElement(rowAndGrid, (el) => el.type === Num && el.props.prop === "paddingLeft"),
    ).not.toBeNull();
  });

  it("uses axis-neutral line gap labels for wrapped mixed flex directions and shows mixed Wrap and Spread states", () => {
    const editor = setup();
    editor.setProp(["included"], "layoutWrap", true);
    editor.setProp(["included"], "justifyContent", "space-between");

    const mixedState = sectionTree(editor, ["included", "column"]);
    const wrapButton = findElement(
      mixedState,
      (el) => el.type === IconButton && el.props.label === "Wrap",
    );
    expect(wrapButton?.props.pressed).toBe("mixed");
    const spreadSwitch = findElement(
      mixedState,
      (el) => el.type === Switch && el.props.label === "Space between",
    );
    expect(spreadSwitch?.props.checked).toBe(false);
    expect(spreadSwitch?.props.indeterminate).toBe(true);
    if (!wrapButton || !spreadSwitch) throw new Error("expected Wrap and Spread controls");
    const spreadMarkup = renderToStaticMarkup(spreadSwitch);
    expect(spreadMarkup).toContain('role="switch"');
    expect(spreadMarkup).toContain('aria-checked="false"');
    expect(spreadMarkup).toContain("dp-switch--mixed");
    expect(spreadMarkup).not.toContain('aria-checked="mixed"');
    const describedId = spreadMarkup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedId).toBeTruthy();
    expect(spreadMarkup).toContain(`id="${describedId}" class="dp-visually-hidden">Mixed</span>`);

    // Turning Wrap on for both shows an axis-neutral line gap control across row and column.
    (wrapButton.props.onClick as () => void)();
    expect(getProp(editor.doc.get("included")?.props ?? {}, "layoutWrap")).toBe(true);
    expect(getProp(editor.doc.get("column")?.props ?? {}, "layoutWrap")).toBe(true);
    const wrappedMixed = sectionTree(editor, ["included", "column"]);
    const lineGap = findElement(
      wrappedMixed,
      (el) => el.type === Num && el.props.prop === "rowGap",
    );
    expect(lineGap?.props.icon).toBeUndefined();
    expect(lineGap?.props.label).toBe("Line");
    expect(lineGap?.props.ariaLabel).toBe("Gap between lines");

    // Clicking mixed Spread applies space-between across all selected flex frames.
    (spreadSwitch.props.onChange as (checked: boolean) => void)(true);
    expect(getProp(editor.doc.get("column")?.props ?? {}, "justifyContent")).toBe("space-between");
  });
});
