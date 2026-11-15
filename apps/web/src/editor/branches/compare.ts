/**
 * Comparing a branch with main while reviewing it (decision 0012): main as
 * it is now in its own read-only editor, beside the live branch, side by
 * side, under a swipe, or overlaid. The two views move together: a pan or
 * zoom on either side, or a page change on the branch, carries over.
 */
import { type Editor, Interaction, Store } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { shareImages } from "../media";

export type CompareMode = "side" | "swipe" | "overlay";

export interface CompareState {
  readonly mode: CompareMode;
  /** Outline what changed, numbered as the review lists it. */
  readonly highlight: boolean;
  /** Swipe: how much of the width shows main (0–1), from the left. */
  readonly swipe: number;
}

export class CompareView {
  /** Main, read-only. */
  readonly main: Editor;
  readonly interaction: Interaction;
  readonly state = new Store<CompareState>({ mode: "side", highlight: true, swipe: 0.5 });
  readonly #branch: Editor;
  #unlink: (() => void) | null = null;

  constructor(branch: Editor, main: Editor) {
    this.#branch = branch;
    this.main = main;
    this.interaction = new Interaction(main);
    // Same images: a branch starts as a copy of main.
    shareImages(branch, main);
  }

  get s(): CompareState {
    return this.state.get();
  }

  /** Shows main as `nodes`, on the branch's page where main has it. */
  load(nodes: readonly NodeRecord[]): void {
    this.main.loadStatic(nodes);
    this.main.state.set({ selection: [], hover: null });
    this.#follow(this.#branch, this.main);
  }

  /** Moves the two views together until `unlink`. */
  link(): () => void {
    this.#unlink?.();
    let syncing = false;
    const carry = (from: Editor, to: Editor) => () => {
      if (syncing) return;
      syncing = true;
      try {
        this.#follow(from, to);
      } finally {
        syncing = false;
      }
    };
    const offBranch = this.#branch.state.subscribe(carry(this.#branch, this.main));
    const offMain = this.main.state.subscribe(carry(this.main, this.#branch));
    this.#unlink = () => {
      offBranch();
      offMain();
      this.#unlink = null;
    };
    return this.#unlink;
  }

  setMode = (mode: CompareMode): void => this.state.set({ mode });
  setHighlight = (highlight: boolean): void => this.state.set({ highlight });
  setSwipe = (swipe: number): void => this.state.set({ swipe: Math.min(1, Math.max(0, swipe)) });

  /** Puts `to` on `from`'s page (where it has it) and camera, if they differ. */
  #follow(from: Editor, to: Editor): void {
    const { pageId, camera } = from.s;
    if (pageId && to.doc.has(pageId) && to.s.pageId !== pageId) to.setPage(pageId);
    const there = to.s.camera;
    if (there.x !== camera.x || there.y !== camera.y || there.zoom !== camera.zoom)
      to.setCamera(camera);
  }
}

/** The part of a page the changes cover, to show them all at once. */
export function changedBounds(
  editor: Editor,
  ids: readonly string[],
): { x: number; y: number; width: number; height: number } | null {
  const pageId = editor.s.pageId;
  if (!pageId) return null;
  const here = ids.filter((id) => editor.doc.has(id) && editor.doc.pageOf(id)?.id === pageId);
  return editor.scene.unionBounds(here);
}
