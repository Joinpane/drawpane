import type { Point, Rect } from "./geometry";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

/** Maps page coordinates to screen pixels: screen = page × zoom + (x, y). */
/** Screen pixels covered by floating UI on each side of the canvas. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export class Camera {
  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly zoom = 1,
  ) {}

  toScreen(p: Point): Point {
    return { x: p.x * this.zoom + this.x, y: p.y * this.zoom + this.y };
  }

  toPage(p: Point): Point {
    return { x: (p.x - this.x) / this.zoom, y: (p.y - this.y) / this.zoom };
  }

  visibleRect(viewport: { width: number; height: number }): Rect {
    const tl = this.toPage({ x: 0, y: 0 });
    return {
      x: tl.x,
      y: tl.y,
      width: viewport.width / this.zoom,
      height: viewport.height / this.zoom,
    };
  }

  pan(dx: number, dy: number): Camera {
    return new Camera(this.x + dx, this.y + dy, this.zoom);
  }

  /** Zooms keeping the page point under `screen` fixed. */
  zoomAt(screen: Point, zoom: number): Camera {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const page = this.toPage(screen);
    return new Camera(screen.x - page.x * z, screen.y - page.y * z, z);
  }

  /** Fits `rect` in the viewport with padding, never zooming past `maxZoom`. */
  /**
   * The camera that shows `rect` whole and centred, `padding` from the edges,
   * never zoomed past `maxZoom`. `insets` are screen areas covered by floating
   * panels, so the rect lands in the part of the canvas you can actually see.
   */
  fit(
    rect: Rect,
    viewport: { width: number; height: number },
    padding = 64,
    maxZoom = 1,
    insets: Insets = NO_INSETS,
  ): Camera {
    const areaW = Math.max(1, viewport.width - insets.left - insets.right);
    const areaH = Math.max(1, viewport.height - insets.top - insets.bottom);
    // Keep at least half the padding on a small screen rather than nothing to show.
    const pad = Math.min(padding, areaW / 4, areaH / 4);
    const w = Math.max(1, areaW - pad * 2);
    const h = Math.max(1, areaH - pad * 2);
    const z = Math.min(
      maxZoom,
      Math.max(MIN_ZOOM, Math.min(w / Math.max(1, rect.width), h / Math.max(1, rect.height))),
    );
    return new Camera(
      insets.left + areaW / 2 - (rect.x + rect.width / 2) * z,
      insets.top + areaH / 2 - (rect.y + rect.height / 2) * z,
      z,
    );
  }

  equals(other: Camera): boolean {
    return this.x === other.x && this.y === other.y && this.zoom === other.zoom;
  }
}
