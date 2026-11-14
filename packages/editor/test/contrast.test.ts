import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { textContrast } from "../src/contrast";
import { Doc } from "../src/doc";

function doc(
  page: Record<string, unknown>,
  frame: Record<string, unknown>,
  text: Record<string, unknown>,
) {
  const d = new Doc();
  d.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: page },
    { op: "create", id: "f", type: "frame", parent: "p", key: "a0", props: frame },
    { op: "create", id: "t", type: "text", parent: "f", key: "a0", props: text },
  ]);
  return d;
}
const white = { fills: [{ type: "solid", color: "#ffffff" }] };

describe("text contrast", () => {
  it("rates black on white as 21:1, AAA", () => {
    expect(textContrast(doc({}, white, {}), "t")).toEqual({
      ratio: 21,
      level: "AAA",
      background: "#ffffff",
      large: false,
    });
  });

  it("asks less of large text", () => {
    const gray = { fills: [{ type: "solid", color: "#888888" }] };
    expect(textContrast(doc({}, white, gray), "t")).toMatchObject({ ratio: 3.5, level: "fail" });
    expect(textContrast(doc({}, white, { ...gray, fontSize: 24 }), "t")).toMatchObject({
      level: "AA",
      large: true,
    });
  });

  it("composites see-through frames down to the page", () => {
    const tint = { fills: [{ type: "solid", color: "#000000", opacity: 0.5 }] };
    const result = textContrast(
      doc({ backgroundColor: "#ffffff" }, tint, { fills: [{ type: "solid", color: "#ffffff" }] }),
      "t",
    );
    expect(result?.background).toBe("#808080");
  });

  it("says nothing when the page follows the viewer's theme", () => {
    expect(textContrast(doc({}, {}, {}), "t")).toBeNull();
  });
});
