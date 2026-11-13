/**
 * The contract between `Interaction` and tools that live in their own files
 * (the pen, vector edit). Interaction offers each pointer and key event to
 * the active handler first; a handler returns true when it took the event.
 */
import type { PointerInput } from "../interaction";

export interface KeyInput {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  readonly shift: boolean;
  readonly alt: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
}

export interface ToolHandler {
  down(input: PointerInput): boolean;
  move(input: PointerInput): boolean;
  up(input: PointerInput): boolean;
  key(input: KeyInput): boolean;
  /** Ends whatever is in progress (pointer cancel, page change). */
  cancel(): void;
  /** True while a gesture is in progress. */
  readonly busy: boolean;
  readonly cursor: string;
}

/** Screen-space pick radius for anchors and handles. */
export const PICK_PX = 6;
/** Screen-space pick radius for segments. */
export const SEGMENT_PX = 5;
export const DRAG_PX = 3;
