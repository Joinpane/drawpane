/**
 * Decides whether the editor shows its phone view-and-comment layout, its
 * touch-ready tablet editor, or the desktop layout. Derived from viewport
 * dimensions plus pointer capability (`(pointer: coarse)` and `(any-pointer: fine)`).
 *
 * Kept in one small module so layout, chrome, comments and touch gesture
 * arbitration can all read the same classification.
 */
import { useEffect, useState } from "react";

export type WorkspaceMode = "phone" | "tablet" | "desktop";

export interface WorkspaceViewport {
  readonly width: number;
  readonly height: number;
  /** Primary pointer is coarse (touch): `matchMedia("(pointer: coarse)")`. */
  readonly coarse: boolean;
  /** Any fine pointer is available (mouse, trackpad, stylus/Pencil): `matchMedia("(any-pointer: fine)")`. */
  readonly anyFine: boolean;
}

export interface WorkspaceMetrics extends WorkspaceViewport {
  readonly mode: WorkspaceMode;
  /** True on narrow/portrait tablets where only one side panel fits comfortably at once. */
  readonly compactTablet: boolean;
}

/** Shorter side threshold separating touch-only phones from tablets (covers portrait and landscape). */
const PHONE_SHORT_SIDE_MAX = 600;
/** Upper tablet viewport width (covers up to large 1366 px landscape iPads). */
const TABLET_WIDTH_MAX = 1366;
/** Tablet width below which portrait/split-view chrome collapses to one pane and a two-row header. */
const COMPACT_TABLET_WIDTH_MAX = 1000;

/**
 * Classifies the workspace from viewport size and pointer capability:
 * - Phone: coarse primary pointer, no fine pointer (so a mouse, trackpad or Pencil
 *   is never forced into view-only phone mode), and short side under 600 px (keeps
 *   rotated landscape phones in phone mode).
 * - Tablet: coarse primary pointer up to 1366 px wide (including narrow Split View
 *   when a fine pointer or Pencil is present).
 * - Desktop: fine primary pointer or screens wider than 1366 px.
 */
export function classifyWorkspaceMode(viewport: WorkspaceViewport): WorkspaceMode {
  const shortSide = Math.min(viewport.width, viewport.height);
  if (viewport.coarse && !viewport.anyFine && shortSide < PHONE_SHORT_SIDE_MAX) return "phone";
  if (viewport.coarse && viewport.width <= TABLET_WIDTH_MAX) return "tablet";
  return "desktop";
}

/** True when a tablet viewport is too narrow to keep both 240 px side panels open at once. */
export function isCompactTablet(mode: WorkspaceMode, width: number): boolean {
  return mode === "tablet" && width < COMPACT_TABLET_WIDTH_MAX;
}

/** Canvas padding around fitted content for each workspace mode (desktop keeps 64 px). */
export function fitPaddingForMode(mode: WorkspaceMode): number {
  if (mode === "phone") return 20;
  if (mode === "tablet") return 32;
  return 64;
}

function matchesMedia(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

export function readWorkspaceViewport(): WorkspaceViewport {
  if (typeof window === "undefined") {
    return { width: 1440, height: 900, coarse: false, anyFine: true };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    coarse: matchesMedia("(pointer: coarse)"),
    anyFine: matchesMedia("(any-pointer: fine)"),
  };
}

export function readWorkspaceMetrics(): WorkspaceMetrics {
  const vp = readWorkspaceViewport();
  const mode = classifyWorkspaceMode(vp);
  return { ...vp, mode, compactTablet: isCompactTablet(mode, vp.width) };
}

export function currentWorkspaceMode(): WorkspaceMode {
  return classifyWorkspaceMode(readWorkspaceViewport());
}

/** Subscribes to viewport size, orientation and pointer-capability changes. */
export function useWorkspaceMode(): WorkspaceMetrics {
  const [metrics, setMetrics] = useState<WorkspaceMetrics>(() => readWorkspaceMetrics());
  useEffect(() => {
    const update = () => {
      const next = readWorkspaceMetrics();
      setMetrics((prev) =>
        prev.width === next.width &&
        prev.height === next.height &&
        prev.coarse === next.coarse &&
        prev.anyFine === next.anyFine &&
        prev.mode === next.mode &&
        prev.compactTablet === next.compactTablet
          ? prev
          : next,
      );
    };
    const coarseMq =
      typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;
    const fineMq =
      typeof window.matchMedia === "function" ? window.matchMedia("(any-pointer: fine)") : null;
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    coarseMq?.addEventListener("change", update);
    fineMq?.addEventListener("change", update);
    update();
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      coarseMq?.removeEventListener("change", update);
      fineMq?.removeEventListener("change", update);
    };
  }, []);
  return metrics;
}
