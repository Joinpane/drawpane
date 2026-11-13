import { Editor } from "@drawpane/editor";
import { type Op, ROOT_ID } from "@drawpane/model";
import type { ContextMenuAction, ContextMenuEntry } from "@drawpane/ui";
import { describe, expect, it, vi } from "vitest";
import type { ActionContext } from "./actions";
import { type MenuHost, menuFor } from "./menus";

function setup(role: "editor" | "viewer" = "editor") {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role });
  const ops: Op[] = [
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Home" } },
    { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: { name: "Two" } },
    {
      op: "create",
      id: "frame",
      type: "frame",
      parent: "p",
      key: "a0",
      props: { name: "Screen", width: 300, height: 300 },
    },
    {
      op: "create",
      id: "back",
      type: "rect",
      parent: "frame",
      key: "a0",
      props: { name: "Back", width: 200, height: 200 },
    },
    {
      op: "create",
      id: "front",
      type: "rect",
      parent: "frame",
      key: "a1",
      props: { name: "Front", x: 50, y: 50, width: 50, height: 50 },
    },
  ];
  editor.doc.apply(ops);
  editor.setPage("p");
  const noop = () => {};
  const ctx = {
    editor,
    openCommandBar: noop,
    toggleTokens: noop,
    toggleLeftPane: noop,
    toggleRightPane: noop,
    copy: vi.fn(),
    cut: noop,
    paste: noop,
    toggleComments: noop,
    present: noop,
    showTab: noop,
    showHistory: noop,
    saveVersion: noop,
    rename: vi.fn(),
    showShortcuts: noop,
  } satisfies ActionContext;
  const host: MenuHost = {
    ctx,
    pasteAt: vi.fn(),
    renamePage: vi.fn(),
    commentsShown: false,
  };
  return { editor, host, ctx };
}

const labels = (items: readonly ContextMenuEntry[]) =>
  items.map((i) => ("separator" in i ? "—" : "heading" in i ? `#${i.heading}` : i.label));
const find = (items: readonly ContextMenuEntry[], label: string) =>
  items.find((i): i is ContextMenuAction => "label" in i && i.label === label);

describe("context menus", () => {
  it("offers paste, view and help on empty canvas", () => {
    const { host } = setup();
    const items = menuFor(host, { kind: "canvas", x: 0, y: 0, point: { x: 900, y: 900 } });
    expect(labels(items)).toEqual([
      "Paste here",
      "Select all",
      "—",
      "Show comments",
      "Hide other people's cursors",
      "—",
      "Zoom to fit",
      "Zoom to 100%",
      "Zoom in",
      "Zoom out",
      "—",
      "Version history",
      "Keyboard shortcuts",
    ]);
  });

  it("offers what fits the selection, and lists the layers under the pointer", () => {
    const { editor, host } = setup();
    editor.select(["front"]);
    const items = menuFor(host, { kind: "canvas", x: 0, y: 0, point: { x: 60, y: 60 } });
    const l = labels(items);
    expect(l.slice(0, 5)).toEqual(["Copy", "Cut", "Paste here", "Duplicate", "Copy/paste as"]);
    expect(l).toContain("Select layer");
    expect(l).toContain("Rename");
    expect(l.at(-1)).toBe("Delete");
    // Nothing that can't run: no ungroup for a rectangle, no paste properties before a copy.
    expect(l).not.toContain("Ungroup");
    const copyPaste = labels(find(items, "Copy/paste as")?.items ?? []);
    expect(copyPaste).toEqual([
      "Copy as PNG",
      "Copy as SVG",
      "Copy as CSS",
      "—",
      "Copy properties",
    ]);
    const layers = find(items, "Select layer")?.items ?? [];
    // Outermost first, indented by depth, like the layers panel.
    expect(labels(layers)).toEqual(["Screen", "\u2003Back", "\u2003Front"]);
    expect((layers[2] as ContextMenuAction).checked).toBe(true);
    (layers[1] as ContextMenuAction).onSelect?.();
    expect(editor.s.selection).toEqual(["back"]);
  });

  it("runs actions with the page's context", () => {
    const { editor, host, ctx } = setup();
    editor.select(["front"]);
    const items = menuFor(host, { kind: "layers", x: 0, y: 0 });
    find(items, "Rename")?.onSelect?.();
    expect(ctx.rename).toHaveBeenCalled();
    find(items, "Paste")?.onSelect?.();
    expect(host.pasteAt).not.toHaveBeenCalled();
    expect(labels(items)).not.toContain("Select layer");
  });

  it("keeps a viewer's menu to what doesn't edit", () => {
    const { editor, host } = setup("viewer");
    editor.select(["front"]);
    const l = labels(menuFor(host, { kind: "canvas", x: 0, y: 0, point: { x: 60, y: 60 } }));
    expect(l).toContain("Copy");
    expect(l).toContain("Copy/paste as");
    for (const edit of ["Cut", "Paste here", "Delete", "Duplicate", "Group selection", "Rename"])
      expect(l).not.toContain(edit);
  });

  it("offers page actions, and never deleting the last page", () => {
    const { editor, host } = setup();
    const items = menuFor(host, { kind: "page", x: 0, y: 0, pageId: "p2" });
    expect(labels(items)).toEqual(["Open", "Rename", "Duplicate", "Add page", "—", "Delete page"]);
    find(items, "Rename")?.onSelect?.();
    expect(host.renamePage).toHaveBeenCalledWith("p2");
    editor.deletePage("p2");
    expect(labels(menuFor(host, { kind: "page", x: 0, y: 0, pageId: "p" }))).not.toContain(
      "Delete page",
    );
  });
});
