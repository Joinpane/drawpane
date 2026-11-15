import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { moveItem, remapIndex } from "./reorder";

describe("moveItem", () => {
  it("moves an item down, the ones it passes moving up", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up, the ones it passes moving down", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the list as it was for no move or a place outside it, and never changes its input", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, -1, 0)).toEqual(list);
    expect(moveItem(list, 0, 3)).toEqual(list);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("puts the item at `to`, keeps the others' order, and `remapIndex` follows every item", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer(), { minLength: 1, maxLength: 12 })
          .chain((list) =>
            fc.tuple(fc.constant(list), fc.nat(list.length - 1), fc.nat(list.length - 1)),
          ),
        ([list, from, to]) => {
          const moved = moveItem(list, from, to);
          expect(moved[to]).toBe(list[from]);
          expect(moved.filter((_, i) => i !== to)).toEqual(list.filter((_, i) => i !== from));
          for (let i = 0; i < list.length; i++)
            expect(moved[remapIndex(i, from, to)]).toBe(list[i]);
        },
      ),
    );
  });

  it("a move shown in reverse is the same move on the list (paints list topmost first)", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 10 })
          .chain((n) => fc.tuple(fc.constant(n), fc.nat(n - 1), fc.nat(n - 1))),
        ([n, from, to]) => {
          const list = Array.from({ length: n }, (_, i) => i);
          const order = [...list].reverse();
          const shown = moveItem(order, from, to);
          const model = moveItem(list, order[from] as number, order[to] as number);
          expect([...model].reverse()).toEqual(shown);
        },
      ),
    );
  });
});

describe("remapIndex", () => {
  it("moves the moved index, shifts the ones between, and leaves the rest", () => {
    expect(remapIndex(0, 0, 2)).toBe(2);
    expect(remapIndex(1, 0, 2)).toBe(0);
    expect(remapIndex(2, 0, 2)).toBe(1);
    expect(remapIndex(3, 0, 2)).toBe(3);
    expect(remapIndex(1, 3, 1)).toBe(2);
    expect(remapIndex(0, 3, 1)).toBe(0);
  });
});
