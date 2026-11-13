import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValidOrderKey, keyBetween, keysBetween, OrderKeyError } from "../src/order-key";

describe("keyBetween", () => {
  it("starts at a0 and appends and prepends", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween(null, "a0")).toBe("Zz");
    expect(keyBetween("a0", "a1")).toBe("a0V");
  });

  it("rejects bad input", () => {
    expect(() => keyBetween("a1", "a0")).toThrow(OrderKeyError);
    expect(() => keyBetween("a0", "a0")).toThrow(OrderKeyError);
    expect(() => keyBetween("a00", null)).toThrow(OrderKeyError);
    expect(() => keyBetween("!", null)).toThrow(OrderKeyError);
  });

  it("always lands strictly between its neighbours", () => {
    // Build random sequences of inserts at random positions and check order holds.
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 200 }), (positions) => {
        const keys: string[] = [];
        for (const p of positions) {
          const i = p % (keys.length + 1);
          const key = keyBetween(keys[i - 1] ?? null, keys[i] ?? null);
          expect(isValidOrderKey(key)).toBe(true);
          keys.splice(i, 0, key);
        }
        const sorted = [...keys].sort();
        expect(keys).toEqual(sorted);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it("keeps keys short when appending many times", () => {
    let key: string | null = null;
    for (let i = 0; i < 10_000; i++) key = keyBetween(key, null);
    expect(key?.length).toBeLessThanOrEqual(4);
  });
});

describe("keysBetween", () => {
  it("returns n ordered keys inside the bounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (n) => {
        for (const [a, b] of [
          [null, null],
          ["a0", null],
          [null, "a0"],
          ["a0", "a5"],
        ] as const) {
          const keys = keysBetween(a, b, n);
          expect(keys).toHaveLength(n);
          expect(keys).toEqual([...keys].sort());
          for (const key of keys) {
            if (a) expect(key > a).toBe(true);
            if (b) expect(key < b).toBe(true);
          }
        }
      }),
    );
  });
});

describe("isValidOrderKey", () => {
  it.each(["a0", "a1V", "Zz", "b00", "A00000000000000000000000001"])("accepts %s", (key) => {
    expect(isValidOrderKey(key)).toBe(true);
  });
  it.each(["", "a", "a0 ", "a10", "A00000000000000000000000000", "b0", "a0-", "x".repeat(200)])(
    "rejects %j",
    (key) => {
      expect(isValidOrderKey(key)).toBe(false);
    },
  );
});
