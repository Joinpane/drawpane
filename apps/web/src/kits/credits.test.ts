import { Editor } from "@drawpane/editor";
import { keyBetween, type NodeRecord, newId, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { firstPage, placeCredit, withCredit } from "./credits";

/** A scratch editor measuring text at 8 px a character, as the editor's tests do. */
async function scratch() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  const pageId = newId();
  editor.doc.apply([
    {
      op: "create",
      id: pageId,
      type: "page",
      parent: ROOT_ID,
      key: keyBetween(null, null),
      props: { name: "P" },
    },
  ]);
  editor.setPage(pageId);
  return { editor, pageId };
}

const converted: NodeRecord[] = [
  { id: "P2", type: "page", parent: ROOT_ID, key: "a1", props: { name: "Second" } },
  { id: "P1", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Cover" } },
  {
    id: "F1",
    type: "frame",
    parent: "P1",
    key: "a0",
    props: { name: "Card", x: 100, y: 300, width: 400, height: 200 },
  },
  {
    id: "F2",
    type: "frame",
    parent: "P1",
    key: "a1",
    props: { name: "Hero", x: 40, y: 500, width: 400, height: 200 },
  },
];

describe("kit credit", () => {
  it("finds the first page by key, and goes above its content", () => {
    expect(firstPage(converted)?.id).toBe("P1");
    expect(placeCredit(converted.slice(2), { height: 180 })).toEqual({ x: 40, y: 300 - 180 - 120 });
    expect(placeCredit([], { height: 180 })).toEqual({ x: 0, y: 0 });
  });

  it("adds an About this kit frame in front, with the credit's lines", async () => {
    const nodes = await withCredit(
      converted,
      "Lucide Icons",
      ['"Lucide Icons" by Kemie.', "Licence: MIT"],
      scratch,
    );
    const frame = nodes.find((n) => n.props.name === "About this kit");
    expect(frame?.parent).toBe("P1");
    expect(frame && frame.key > "a1").toBe(true);
    const texts = nodes.filter((n) => n.parent === frame?.id).map((n) => n.props.characters);
    expect(texts).toEqual([
      "About this kit",
      "Lucide Icons",
      '"Lucide Icons" by Kemie.',
      "Licence: MIT",
    ]);
    expect(frame?.props.x).toBe(40);
    expect(Number(frame?.props.y) + Number(frame?.props.height)).toBe(300 - 120);
    // The scratch file's own page doesn't come along.
    expect(nodes.filter((n) => n.type === "page")).toHaveLength(2);
  });

  it("leaves a file without pages alone", async () => {
    const lone: NodeRecord[] = [];
    expect(await withCredit(lone, "X", [], scratch)).toBe(lone);
  });
});
