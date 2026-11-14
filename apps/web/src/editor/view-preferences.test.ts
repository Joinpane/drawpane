import { describe, expect, it } from "vitest";
import { readViewPreferences } from "./view-preferences";

describe("readViewPreferences", () => {
  it("reads the rulers, layout grids, pixel-grid snapping, the Selection Lens and the minimap", () => {
    expect(
      readViewPreferences(
        '{"rulers":true,"layoutGrids":false,"pixelSnap":false,"lens":false,"minimap":"always"}',
      ),
    ).toEqual({
      rulers: true,
      layoutGrids: false,
      pixelSnap: false,
      lens: false,
      minimap: "always",
    });
  });

  it("reads the minimap's old on and off as showing while moving around, and off", () => {
    expect(readViewPreferences('{"minimap":true}')).toEqual({ minimap: "auto" });
    expect(readViewPreferences('{"minimap":false}')).toEqual({ minimap: "off" });
    expect(readViewPreferences('{"minimap":"sometimes"}')).toEqual({});
  });

  it("keeps only well-formed values, so older or damaged storage still opens", () => {
    expect(readViewPreferences('{"rulers":"yes","lens":true,"other":1}')).toEqual({ lens: true });
    expect(readViewPreferences("not json")).toEqual({});
    expect(readViewPreferences(null)).toEqual({});
    expect(readViewPreferences("[]")).toEqual({});
  });
});
