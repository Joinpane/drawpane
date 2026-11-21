import { describe, expect, it } from "vitest";
import { editorSearch, parseAppSearch, stringifyAppSearch, writeEditorSearch } from "./editor-link";

describe("editor links", () => {
  it.each([
    ["0", "true"],
    ["01", "-37"],
    ["ad3420a1-809a-4b50-aa4c-c1f1b0ee6cd9", "layer_2"],
  ])("round-trips literal model ids %s and %s through router search", (page, node) => {
    const search = { "page-id": page, "node-id": node, review: true, renderer: "canvas" };
    const query = stringifyAppSearch(search);
    expect(new URLSearchParams(query).get("page-id")).toBe(page);
    expect(new URLSearchParams(query).get("node-id")).toBe(node);
    expect(parseAppSearch(query)).toEqual(search);
  });

  it("accepts page-only and node-only targets", () => {
    expect(editorSearch(parseAppSearch("?page-id=page1"))).toEqual({ "page-id": "page1" });
    expect(editorSearch(parseAppSearch("?node-id=node1"))).toEqual({ "node-id": "node1" });
  });

  it("ignores invalid targets", () => {
    expect(parseAppSearch("?page-id=%22page1%22&node-id=one%2Ftwo&review=true")).toEqual({
      review: true,
    });
    expect(editorSearch({ "page-id": "root", "node-id": "x".repeat(65) })).toEqual({});
  });

  it("changes only the target when copying a page or clearing a selection", () => {
    const params = new URLSearchParams(
      "page-id=first&node-id=layer&thread=note&review=1&renderer=engine&present=readback&extra=keep",
    );
    writeEditorSearch(params, { "page-id": "second" });
    expect(Object.fromEntries(params)).toEqual({
      "page-id": "second",
      thread: "note",
      review: "1",
      renderer: "engine",
      present: "readback",
      extra: "keep",
    });
  });
});
