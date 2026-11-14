/**
 * Accessibility checks that show at selection (PRD: "touch-target warnings
 * appear at selection"). A layer is a tap target when the prototype taps it,
 * and on a board sized for a phone or tablet it should be at least 44 × 44
 * (WCAG 2.5.5, and Apple's Human Interface Guidelines).
 */
import { getProp } from "@drawpane/model";
import type { Editor } from "./editor";

/** The smallest comfortable tap target, in points. */
export const MIN_TAP_TARGET = 44;
/** Boards up to this wide are phones and tablets: touched, not clicked. */
export const TOUCH_BOARD_MAX_WIDTH = 1024;

export interface TapTargetIssue {
  readonly width: number;
  readonly height: number;
  readonly min: number;
  /** Whether "grow" can fix it (not text or a group, whose size follows their content). */
  readonly growable: boolean;
}

/** The board (top-level frame) a layer is on, or null for a layer on the page itself. */
function boardOf(editor: Editor, id: string): string | null {
  const pageId = editor.s.pageId;
  let node = editor.doc.get(id);
  while (node && node.parent !== pageId) node = editor.doc.get(node.parent);
  return node && node.id !== id && node.type === "frame" ? node.id : null;
}

/** Why a selected layer is too small to tap comfortably, or null when it's fine (or not tapped). */
export function tapTargetIssue(editor: Editor, id: string): TapTargetIssue | null {
  const node = editor.doc.get(id);
  if (!node) return null;
  const tapped = getProp(node.props, "reactions").some((r) => r.trigger.type === "tap");
  if (!tapped) return null;
  const board = boardOf(editor, id);
  const boardWidth = board ? getProp(editor.doc.get(board)?.props ?? {}, "width") : null;
  if (boardWidth === null || boardWidth > TOUCH_BOARD_MAX_WIDTH) return null;
  const bounds = editor.scene.bounds(id);
  if (!bounds) return null;
  const width = Math.round(bounds.width * 100) / 100;
  const height = Math.round(bounds.height * 100) / 100;
  if (width >= MIN_TAP_TARGET && height >= MIN_TAP_TARGET) return null;
  return {
    width,
    height,
    min: MIN_TAP_TARGET,
    growable: node.type !== "text" && node.type !== "group",
  };
}
