/**
 * Small caches keyed by path data, so the renderer, hit testing and the
 * overlay parse each `d` string once however often they ask.
 */
import type { VectorPath } from "./path";
import { parsePath } from "./svg";

const LIMIT = 256;

class Lru<V> {
  readonly #map = new Map<string, V>();
  get(key: string, make: () => V): V {
    const hit = this.#map.get(key);
    if (hit !== undefined) {
      // Refresh recency.
      this.#map.delete(key);
      this.#map.set(key, hit);
      return hit;
    }
    const value = make();
    this.#map.set(key, value);
    if (this.#map.size > LIMIT) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    return value;
  }
}

const parsed = new Lru<VectorPath>();

export function parsePathCached(d: string): VectorPath {
  return parsed.get(d, () => parsePath(d));
}

/** True when every subpath is closed (so inside and outside strokes make sense). */
export function isClosedPath(d: string): boolean {
  const path = parsePathCached(d);
  return path.length > 0 && path.every((sub) => sub.closed);
}

export { Lru };
