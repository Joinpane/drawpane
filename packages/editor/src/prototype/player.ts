/**
 * The prototype player's state machine, independent of any view.
 *
 * It knows which screen is showing, which overlays sit on top of it and how
 * you got there, and turns a reaction into a step: navigate, open, swap or
 * close an overlay, or open a link. The view hit-tests, animates each step
 * and calls back in; nothing here touches the DOM, so it is fully testable.
 */
import {
  actionTarget,
  type OverlayPosition,
  type Reaction,
  type Transition,
  type Trigger,
} from "@drawpane/model";
import type { Doc } from "../doc";
import type { Point, Rect } from "../geometry";
import { hitsNode } from "../hit";
import type { Scene } from "../scene";
import { reverseTransition } from "./motion";
import { isLiveTarget, isScreen, reactionsOf } from "./screens";

export interface OverlayLayer {
  /** Unique per opening, so the view can tell two openings of one screen apart. */
  readonly key: number;
  readonly screen: string;
  readonly position: OverlayPosition;
  readonly closeOnOutside: boolean;
  readonly dim: number;
  /** How it opened; closing plays the reverse. */
  readonly transition: Transition;
}

export type PlayerStep =
  | {
      readonly type: "navigate";
      readonly from: string;
      readonly to: string;
      readonly transition: Transition;
      readonly back: boolean;
      /** Overlays that closed with the navigation (they close instantly). */
      readonly closed: readonly OverlayLayer[];
    }
  | { readonly type: "open-overlay"; readonly overlay: OverlayLayer }
  | { readonly type: "close-overlay"; readonly overlay: OverlayLayer }
  | {
      readonly type: "swap-overlay";
      readonly from: OverlayLayer;
      readonly to: OverlayLayer;
      readonly transition: Transition;
    }
  | { readonly type: "open-url"; readonly url: string; readonly newTab: boolean };

export interface PlayerState {
  readonly screen: string;
  readonly overlays: readonly OverlayLayer[];
  /** Screens Back returns to, oldest first. */
  readonly history: readonly { readonly screen: string; readonly transition: Transition }[];
}

export interface Hit {
  /** The layer that owns the reaction (the tapped layer or an ancestor). */
  readonly source: string;
  readonly reaction: Reaction;
}

export interface KeyPress {
  readonly key: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
}

const INSTANT: Transition = {
  type: "instant",
  direction: "left",
  duration: 0,
  easing: { type: "linear" },
};

export class PrototypePlayer {
  readonly #doc: Doc;
  #state: PlayerState;
  #start: string;
  #nextKey = 1;
  readonly #listeners = new Set<() => void>();

  constructor(doc: Doc, start: string) {
    this.#doc = doc;
    this.#start = start;
    this.#state = { screen: start, overlays: [], history: [] };
  }

  get state(): PlayerState {
    return this.#state;
  }

  get start(): string {
    return this.#start;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: PlayerState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  /** The layers that take input, topmost first: open overlays, then the screen. */
  roots(): string[] {
    return [...this.#state.overlays.map((o) => o.screen).reverse(), this.#state.screen];
  }

  /** Back to the start (or a new start), with nothing open. */
  restart(start = this.#start): void {
    this.#start = start;
    this.#set({ screen: start, overlays: [], history: [] });
  }

  /**
   * Jumps straight to a screen (from the screen strip or the arrow keys).
   * Back still returns to where you were.
   */
  goTo(screen: string, transition: Transition = INSTANT): PlayerStep | null {
    if (!isScreen(this.#doc, screen)) return null;
    return this.#navigate(screen, transition);
  }

  /** The first reaction for a trigger on the tapped layer or its ancestors. */
  find(chain: readonly string[], type: Trigger["type"]): Hit | null {
    for (const id of chain) {
      const reaction = reactionsOf(this.#doc.get(id)).find((r) => r.trigger.type === type);
      if (reaction) return { source: id, reaction };
    }
    return null;
  }

  /** A key reaction anywhere in the topmost layer that has one. */
  findKey(press: KeyPress): Hit | null {
    const matches = (trigger: Trigger) =>
      trigger.type === "key" &&
      trigger.key.toLowerCase() === press.key.toLowerCase() &&
      trigger.shift === press.shift &&
      trigger.alt === press.alt &&
      trigger.mod === press.mod;
    for (const root of this.roots()) {
      const stack = [root];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        const node = this.#doc.get(id);
        if (!node || node.props.visible === false) continue;
        const reaction = reactionsOf(node).find((r) => matches(r.trigger));
        if (reaction) return { source: id, reaction };
        stack.push(...this.#doc.childIds(id));
      }
    }
    return null;
  }

  /** Reactions that fire after a delay on a screen or overlay (they belong on the frame itself). */
  delays(root: string): Reaction[] {
    return reactionsOf(this.#doc.get(root)).filter((r) => r.trigger.type === "delay");
  }

  /** Performs a reaction. Null when it does nothing (a deleted destination, the screen already showing). */
  run(hit: Hit): PlayerStep | null {
    const { action, transition } = hit.reaction;
    const target = actionTarget(action);
    if (target && !isLiveTarget(this.#doc, hit.source, target)) return null;
    switch (action.type) {
      case "navigate":
        return this.#navigate(action.to, transition);
      case "overlay": {
        if (this.#state.overlays.at(-1)?.screen === action.to) return null;
        const overlay: OverlayLayer = {
          key: this.#nextKey++,
          screen: action.to,
          position: action.position,
          closeOnOutside: action.closeOnOutside,
          dim: action.dim,
          transition,
        };
        this.#set({ ...this.#state, overlays: [...this.#state.overlays, overlay] });
        return { type: "open-overlay", overlay };
      }
      case "swap-overlay": {
        const from = this.#state.overlays.at(-1);
        if (!from) return this.#navigate(action.to, transition);
        if (from.screen === action.to) return null;
        const to: OverlayLayer = { ...from, key: this.#nextKey++, screen: action.to, transition };
        this.#set({ ...this.#state, overlays: [...this.#state.overlays.slice(0, -1), to] });
        return { type: "swap-overlay", from, to, transition };
      }
      case "close-overlay":
        return this.closeOverlay();
      case "back":
        return this.back();
      case "url":
        return { type: "open-url", url: action.url, newTab: action.newTab };
    }
  }

  /** Closes the topmost overlay, or the given one and everything above it. */
  closeOverlay(key?: number): PlayerStep | null {
    const overlays = this.#state.overlays;
    const index =
      key === undefined ? overlays.length - 1 : overlays.findIndex((o) => o.key === key);
    const overlay = overlays[index];
    if (!overlay) return null;
    this.#set({ ...this.#state, overlays: overlays.slice(0, index) });
    return { type: "close-overlay", overlay };
  }

  /** Closes the top overlay if one is open; otherwise returns to the previous screen. */
  back(): PlayerStep | null {
    if (this.#state.overlays.length > 0) return this.closeOverlay();
    const previous = this.#state.history.at(-1);
    if (!previous) return null;
    const from = this.#state.screen;
    this.#set({ screen: previous.screen, overlays: [], history: this.#state.history.slice(0, -1) });
    return {
      type: "navigate",
      from,
      to: previous.screen,
      transition: reverseTransition(previous.transition),
      back: true,
      closed: [],
    };
  }

  /**
   * Undoes what a hover did when the pointer leaves: closes the overlay it
   * opened, or goes back from the screen it navigated to.
   */
  revert(step: PlayerStep): PlayerStep | null {
    switch (step.type) {
      case "open-overlay":
        return this.#state.overlays.some((o) => o.key === step.overlay.key)
          ? this.closeOverlay(step.overlay.key)
          : null;
      case "swap-overlay":
        return this.#state.overlays.at(-1)?.key === step.to.key
          ? this.closeOverlay(step.to.key)
          : null;
      case "navigate":
        return this.#state.screen === step.to && !step.back ? this.back() : null;
      default:
        return null;
    }
  }

  #navigate(to: string, transition: Transition): PlayerStep | null {
    const { screen, overlays, history } = this.#state;
    if (to === screen && overlays.length === 0) return null;
    this.#set({ screen: to, overlays: [], history: [...history, { screen, transition }] });
    return { type: "navigate", from: screen, to, transition, back: false, closed: overlays };
  }
}

// ---------------------------------------------------------------------------
// Geometry for the view

/**
 * The layers under a point inside a screen or overlay, deepest first and
 * ending with the root. Hidden layers don't count; locked ones do (locking is
 * an editing aid, not part of the prototype). Clipping frames only pass hits
 * inside their box.
 */
export function chainAt(scene: Scene, rootId: string, p: Point): string[] {
  const doc = scene.doc;
  const visit = (id: string): string[] | null => {
    const node = doc.get(id);
    if (!node || node.props.visible === false) return null;
    const clips = node.type === "frame" && node.props.clipContent !== false;
    if (clips && !hitsNode(scene, node, p, 0)) return null;
    const children = doc.childIds(id);
    for (let i = children.length - 1; i >= 0; i--) {
      const hit = visit(children[i] as string);
      if (hit) {
        hit.push(id);
        return hit;
      }
    }
    if (node.type === "group") return null;
    return hitsNode(scene, node, p, 0) ? [id] : null;
  };
  return visit(rootId) ?? [];
}

/**
 * Where a screen's hotspots are, relative to the screen's top-left: the layers
 * that respond to taps, hovers or drags. The player flashes these when you
 * tap somewhere that does nothing.
 */
export function hotspotRects(scene: Scene, rootId: string): Rect[] {
  const doc = scene.doc;
  const origin = scene.bounds(rootId);
  if (!origin) return [];
  const out: Rect[] = [];
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node || node.props.visible === false) return;
    if (
      id !== rootId &&
      reactionsOf(node).some((r) => r.trigger.type !== "key" && r.trigger.type !== "delay")
    ) {
      const b = scene.bounds(id);
      if (b) out.push({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height });
    }
    for (const child of doc.childIds(id)) visit(child);
  };
  visit(rootId);
  return out;
}
