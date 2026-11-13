import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom has no pointer capture; NumberField scrubbing relies on it.
const captured = new WeakMap<Element, Set<number>>();
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function (this: Element, id: number) {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(id);
    captured.set(this, ids);
  };
  Element.prototype.releasePointerCapture = function (this: Element, id: number) {
    captured.get(this)?.delete(id);
  };
  Element.prototype.hasPointerCapture = function (this: Element, id: number) {
    return captured.get(this)?.has(id) ?? false;
  };
}
