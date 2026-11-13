/**
 * Reading a prototype out of the document: which frames are screens, what
 * each layer does, where flows lead, and how to say it in a sentence.
 *
 * A screen is a visible top-level frame on a page. Reactions can sit on any
 * layer inside one; destinations are other screens on the same page.
 */
import {
  type Action,
  actionTarget,
  DEFAULT_TRANSITION,
  type Easing,
  type Flow,
  getProp,
  type NodeRecord,
  newId,
  type Reaction,
  type Transition,
  type Trigger,
} from "@drawpane/model";
import type { Doc } from "../doc";

/** True for a frame that sits directly on a page. */
export function isScreen(doc: Doc, id: string): boolean {
  const node = doc.get(id);
  return node?.type === "frame" && doc.get(node.parent)?.type === "page";
}

/** Top-level frames on a page, in layer order (top of the list first, like the layers panel). */
export function screensOf(doc: Doc, pageId: string): string[] {
  return doc
    .childIds(pageId)
    .filter((id) => isScreen(doc, id) && doc.get(id)?.props.visible !== false)
    .reverse();
}

/**
 * Screens in reading order: row by row from the top, left to right within a
 * row. Frames whose tops sit within half a frame's height of each other share
 * a row, so a slightly uneven line of screens still reads as one.
 */
export function screensInReadingOrder(doc: Doc, pageId: string): string[] {
  const boxes = screensOf(doc, pageId).map((id) => {
    const props = doc.get(id)?.props ?? {};
    return { id, x: getProp(props, "x"), y: getProp(props, "y"), h: getProp(props, "height") };
  });
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: (typeof boxes)[] = [];
  for (const box of boxes) {
    const row = rows.at(-1);
    const top = row?.[0];
    if (row && top && box.y < top.y + Math.min(...row.map((r) => r.h)) / 2) row.push(box);
    else rows.push([box]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x).map((b) => b.id));
}

/** The screen a layer belongs to, or null for layers loose on the page. */
export function screenOf(doc: Doc, id: string): string | null {
  for (let node = doc.get(id); node; node = doc.get(node.parent)) {
    if (isScreen(doc, node.id)) return node.id;
    if (node.type === "page") return null;
  }
  return null;
}

/** The page a node is on. */
export function pageOf(doc: Doc, id: string): string | null {
  for (let node = doc.get(id); node; node = doc.get(node.parent)) {
    if (node.type === "page") return node.id;
  }
  return null;
}

export function reactionsOf(node: NodeRecord | undefined): readonly Reaction[] {
  return node ? getProp(node.props, "reactions") : [];
}

/** A destination that is still a screen on the source's page. */
export function isLiveTarget(doc: Doc, sourceId: string, target: string): boolean {
  return isScreen(doc, target) && pageOf(doc, target) === pageOf(doc, sourceId);
}

/** Every layer in a subtree (the root included) that has reactions, depth first. */
export function hotspotIds(doc: Doc, rootId: string): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node || node.props.visible === false) return;
    if (reactionsOf(node).length > 0) out.push(id);
    for (const child of doc.childIds(id)) visit(child);
  };
  visit(rootId);
  return out;
}

/**
 * Screens a flow reaches from its start, breadth first, following every
 * navigate, overlay and swap. The order is the order a person would meet
 * them, which is how the player lists them.
 */
export function flowScreens(doc: Doc, start: string): string[] {
  if (!isScreen(doc, start)) return [];
  const seen = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const screen = queue[i] as string;
    for (const id of hotspotIds(doc, screen)) {
      for (const reaction of reactionsOf(doc.get(id))) {
        const target = actionTarget(reaction.action);
        if (target && !seen.has(target) && isLiveTarget(doc, id, target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return queue;
}

/** Flows on a page whose start screen still exists. */
export function liveFlows(doc: Doc, pageId: string): Flow[] {
  const page = doc.get(pageId);
  if (page?.type !== "page") return [];
  return getProp(page.props, "flows").filter((flow) => isScreen(doc, flow.start));
}

/** The screen a prototype opens on when no flow is chosen: the first flow's start, else the first screen. */
export function defaultStart(doc: Doc, pageId: string): string | null {
  return liveFlows(doc, pageId)[0]?.start ?? screensOf(doc, pageId)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Building reactions

/** A new tap → navigate reaction with the default transition. */
export function newReaction(to: string | null, trigger: Trigger = { type: "tap" }): Reaction {
  const action: Action = to ? { type: "navigate", to } : { type: "back" };
  return { id: newId(), trigger, action, transition: DEFAULT_TRANSITION };
}

/**
 * Switching an action's type keeps what still makes sense: the destination
 * carries over between navigate, overlay and swap.
 */
export function changeActionType(action: Action, type: Action["type"], fallback: string): Action {
  const to = actionTarget(action) ?? fallback;
  switch (type) {
    case "navigate":
      return { type, to };
    case "overlay":
      return { type, to, position: "center", closeOnOutside: true, dim: 0.4 };
    case "swap-overlay":
      return { type, to };
    case "close-overlay":
    case "back":
      return { type };
    case "url":
      return { type, url: "https://", newTab: true };
  }
}

/** Switching the trigger type, with the defaults each one needs. */
export function changeTriggerType(trigger: Trigger, type: Trigger["type"]): Trigger {
  if (trigger.type === type) return trigger;
  switch (type) {
    case "key":
      return { type, key: "ArrowRight", shift: false, alt: false, mod: false };
    case "delay":
      return { type, ms: 800 };
    default:
      return { type };
  }
}

// ---------------------------------------------------------------------------
// Sentences

export const TRIGGER_LABEL: Record<Trigger["type"], string> = {
  tap: "On tap",
  hover: "While hovering",
  drag: "On drag",
  key: "On key",
  delay: "After delay",
};

export const ACTION_LABEL: Record<Action["type"], string> = {
  navigate: "Navigate to",
  overlay: "Open overlay",
  "swap-overlay": "Swap overlay",
  "close-overlay": "Close overlay",
  back: "Back",
  url: "Open link",
};

export const TRANSITION_LABEL: Record<Transition["type"], string> = {
  instant: "Instant",
  dissolve: "Dissolve",
  "move-in": "Move in",
  "move-out": "Move out",
  push: "Push",
  "slide-in": "Slide in",
  "slide-out": "Slide out",
};

export const EASING_LABEL: Record<Easing["type"], string> = {
  linear: "Linear",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in and out",
  bezier: "Custom bezier",
  spring: "Spring",
};

const KEY_NAMES: Record<string, string> = {
  ArrowRight: "→",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
  Escape: "Esc",
};

/** "⌘⇧K", "→", "Space": a key trigger as people write it. */
export function keyLabel(trigger: Extract<Trigger, { type: "key" }>): string {
  const key =
    KEY_NAMES[trigger.key] ?? (trigger.key.length === 1 ? trigger.key.toUpperCase() : trigger.key);
  return `${trigger.mod ? "⌘" : ""}${trigger.alt ? "⌥" : ""}${trigger.shift ? "⇧" : ""}${key}`;
}

export function triggerLabel(trigger: Trigger): string {
  if (trigger.type === "key") return `On ${keyLabel(trigger)}`;
  if (trigger.type === "delay") return `After ${formatMs(trigger.ms)}`;
  return TRIGGER_LABEL[trigger.type];
}

export function formatMs(ms: number): string {
  return ms >= 1000 && ms % 100 === 0 ? `${ms / 1000} s` : `${Math.round(ms)} ms`;
}

/** The name of a layer for sentences, or a note that it's gone. */
function nameOf(doc: Doc, id: string): string {
  const node = doc.get(id);
  if (!node) return "a deleted screen";
  return getProp(node.props, "name") || "Untitled";
}

/** "Navigate to Event detail", "Open overlay Sheet", "Open drawpane.dev". */
export function actionSentence(doc: Doc, action: Action): string {
  switch (action.type) {
    case "navigate":
    case "overlay":
    case "swap-overlay":
      return `${ACTION_LABEL[action.type]} ${nameOf(doc, action.to)}`;
    case "url":
      return `Open ${action.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    default:
      return ACTION_LABEL[action.type];
  }
}

/** "Dissolve · 240 ms", "Move in ← · Spring", "Instant". */
export function transitionSentence(transition: Transition): string {
  if (transition.type === "instant") return "Instant";
  const arrow =
    transition.type === "dissolve"
      ? ""
      : ` ${{ left: "←", right: "→", up: "↑", down: "↓" }[transition.direction]}`;
  const timing = transition.easing.type === "spring" ? "Spring" : formatMs(transition.duration);
  return `${TRANSITION_LABEL[transition.type]}${arrow} · ${timing}`;
}

/** Whether a transition plays for this action (links and closing have none to choose). */
export function hasTransition(action: Action): boolean {
  return action.type !== "url" && action.type !== "close-overlay";
}

/**
 * One reaction as a sentence a reviewer can read like copy:
 * "On tap → Navigate to Event detail · Dissolve · 240 ms".
 */
export function reactionSentence(doc: Doc, reaction: Reaction): string {
  const base = `${triggerLabel(reaction.trigger)} → ${actionSentence(doc, reaction.action)}`;
  return hasTransition(reaction.action) && reaction.action.type !== "back"
    ? `${base} · ${transitionSentence(reaction.transition)}`
    : base;
}
