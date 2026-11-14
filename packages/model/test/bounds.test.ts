import { describe, expect, it } from "vitest";
import { PROP_NAMES, PROPS, propBounds } from "../src/schema";

describe("propBounds", () => {
  it("knows each number property's range, through optional and nullable", () => {
    expect(propBounds("cornerRadius")).toEqual({ min: 0 });
    expect(propBounds("opacity")).toEqual({ min: 0, max: 1 });
    expect(propBounds("minWidth")).toEqual({ min: 0 });
    expect(propBounds("fontSize")).toEqual({ min: 1, max: 4096 });
    expect(propBounds("pointCount")).toEqual({ min: 3, max: 60 });
    // Any number.
    expect(propBounds("x")).toEqual({});
    expect(propBounds("rotation")).toEqual({});
    expect(propBounds("name")).toEqual({});
  });

  it("only offers values the schema accepts", () => {
    for (const name of PROP_NAMES) {
      const { min, max } = propBounds(name);
      const schema = PROPS[name].schema;
      if (min !== undefined) {
        expect(schema.safeParse(min).success, `${name} at its min`).toBe(true);
        expect(schema.safeParse(min - 1).success, `${name} under its min`).toBe(false);
      }
      if (max !== undefined) {
        expect(schema.safeParse(max).success, `${name} at its max`).toBe(true);
        expect(schema.safeParse(max + 1).success, `${name} over its max`).toBe(false);
      }
    }
  });
});
