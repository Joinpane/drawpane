import { describe, expect, it } from "vitest";
import { readViewPreferences } from "./view-preferences";

describe("readViewPreferences", () => {
  it("reads the rulers, layout grids and the Selection Lens", () => {
    expect(readViewPreferences('{"rulers":true,"layoutGrids":false,"lens":false}')).toEqual({
      rulers: true,
      layoutGrids: false,
      lens: false,
    });
  });

  it("keeps only well-formed values, so older or damaged storage still opens", () => {
    expect(readViewPreferences('{"rulers":"yes","lens":true,"other":1}')).toEqual({ lens: true });
    expect(readViewPreferences("not json")).toEqual({});
    expect(readViewPreferences(null)).toEqual({});
    expect(readViewPreferences("[]")).toEqual({});
  });
});
