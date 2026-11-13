/**
 * Prototype data: what happens when someone taps, hovers, drags or presses a
 * key on a layer, and the flows a prototype starts from.
 *
 * A layer's `reactions` is a list of trigger → action pairs, each with the
 * transition that plays. Destinations are top-level frames ("screens") on the
 * same page, by id. A destination that no longer exists is kept rather than
 * cleaned up, so undo and concurrent edits restore it; players skip it and the
 * editor flags it.
 */
import { z } from "zod";
import { ID_PATTERN } from "./ids";

const finite = z.number().refine(Number.isFinite, "must be a finite number");
const between = (min: number, max: number) =>
  finite.refine((n) => n >= min && n <= max, `must be between ${min} and ${max}`);
const Id = z.string().regex(ID_PATTERN);

// ---------------------------------------------------------------------------
// Triggers

export const TRIGGER_TYPES = ["tap", "hover", "drag", "key", "delay"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap") }),
  /** While the pointer is over the layer; leaving undoes the action. */
  z.object({ type: z.literal("hover") }),
  z.object({ type: z.literal("drag") }),
  z.object({
    type: z.literal("key"),
    /** `KeyboardEvent.key`, e.g. "ArrowRight", "Enter", "k". */
    key: z.string().min(1).max(32),
    shift: z.boolean(),
    alt: z.boolean(),
    /** ⌘ on macOS, Ctrl elsewhere. */
    mod: z.boolean(),
  }),
  /** After the screen has been showing for `ms`. Only on a screen itself. */
  z.object({ type: z.literal("delay"), ms: between(0, 60_000) }),
]);
export type Trigger = z.infer<typeof Trigger>;

// ---------------------------------------------------------------------------
// Actions

export const OVERLAY_POSITIONS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];

/**
 * Only links a browser opens as a page or hands to an app. Never `javascript:`
 * or `data:`: a shared prototype must not run code from a layer.
 */
export const SafeUrl = z
  .string()
  .max(2048)
  .regex(
    /^(?:https?:\/\/[^\s/?#]+[^\s]*|mailto:[^\s]+|tel:[0-9+().\- ]+)$/i,
    "must be an http, https, mailto or tel link",
  );

export const ACTION_TYPES = [
  "navigate",
  "overlay",
  "swap-overlay",
  "close-overlay",
  "back",
  "url",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), to: Id }),
  z.object({
    type: z.literal("overlay"),
    to: Id,
    position: z.enum(OVERLAY_POSITIONS),
    /** Tapping outside the overlay closes it. */
    closeOnOutside: z.boolean(),
    /** How much the screen underneath dims, 0 to 1. */
    dim: between(0, 1),
  }),
  /** Replaces the topmost overlay, keeping its position. */
  z.object({ type: z.literal("swap-overlay"), to: Id }),
  z.object({ type: z.literal("close-overlay") }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("url"), url: SafeUrl, newTab: z.boolean() }),
]);
export type Action = z.infer<typeof Action>;

// ---------------------------------------------------------------------------
// Transitions

export const TRANSITION_TYPES = [
  "instant",
  "dissolve",
  "move-in",
  "move-out",
  "push",
  "slide-in",
  "slide-out",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const DIRECTIONS = ["left", "right", "up", "down"] as const;
export type Direction = (typeof DIRECTIONS)[number];

const unitX = between(0, 1);
export const Easing = z.discriminatedUnion("type", [
  z.object({ type: z.literal("linear") }),
  z.object({ type: z.literal("ease-in") }),
  z.object({ type: z.literal("ease-out") }),
  z.object({ type: z.literal("ease-in-out") }),
  /** CSS `cubic-bezier()`: x values stay in 0..1, y values may overshoot. */
  z.object({
    type: z.literal("bezier"),
    x1: unitX,
    y1: between(-2, 3),
    x2: unitX,
    y2: between(-2, 3),
  }),
  /** A damped spring. Its duration is how long it takes to settle. */
  z.object({
    type: z.literal("spring"),
    mass: between(0.1, 10),
    stiffness: between(1, 2000),
    damping: between(0.1, 200),
  }),
]);
export type Easing = z.infer<typeof Easing>;

export const Transition = z.object({
  type: z.enum(TRANSITION_TYPES),
  /** Which way the motion goes; ignored by instant and dissolve. */
  direction: z.enum(DIRECTIONS),
  /** Milliseconds; ignored by instant and by springs, which settle in their own time. */
  duration: between(0, 10_000),
  easing: Easing,
});
export type Transition = z.infer<typeof Transition>;

// ---------------------------------------------------------------------------
// Reactions and flows

export const Reaction = z.object({
  id: Id,
  trigger: Trigger,
  action: Action,
  transition: Transition,
});
export type Reaction = z.infer<typeof Reaction>;

export const Reactions = z
  .array(Reaction)
  .max(32)
  .refine((list) => new Set(list.map((r) => r.id)).size === list.length, "ids must be unique");

export const Flow = z.object({
  id: Id,
  name: z.string().min(1).max(64),
  /** The screen the flow starts on. */
  start: Id,
  description: z.string().max(2000),
});
export type Flow = z.infer<typeof Flow>;

export const Flows = z
  .array(Flow)
  .max(64)
  .refine((list) => new Set(list.map((f) => f.id)).size === list.length, "ids must be unique");

/**
 * Devices a prototype can be shown in. `none` shows the screen as it is,
 * fitted to the window; the rest add the device's frame and size the screen
 * to its width.
 */
export const DEVICES = {
  none: { name: "No device", width: 0, height: 0, kind: "none" },
  "iphone-16": { name: "iPhone 16", width: 393, height: 852, kind: "phone" },
  "iphone-16-pro-max": { name: "iPhone 16 Pro Max", width: 440, height: 956, kind: "phone" },
  "iphone-se": { name: "iPhone SE", width: 375, height: 667, kind: "phone" },
  "pixel-9": { name: "Pixel 9", width: 412, height: 923, kind: "phone" },
  "ipad-mini": { name: "iPad mini", width: 744, height: 1133, kind: "tablet" },
  "ipad-pro-11": { name: "iPad Pro 11″", width: 834, height: 1194, kind: "tablet" },
  desktop: { name: "Desktop", width: 1440, height: 900, kind: "desktop" },
} as const satisfies Record<
  string,
  { name: string; width: number; height: number; kind: "none" | "phone" | "tablet" | "desktop" }
>;
export type DeviceId = keyof typeof DEVICES;
export const DEVICE_IDS = Object.keys(DEVICES) as [DeviceId, ...DeviceId[]];

/** A sensible starting transition: a quick dissolve. */
export const DEFAULT_TRANSITION: Transition = {
  type: "dissolve",
  direction: "left",
  duration: 240,
  easing: { type: "ease-out" },
};

/** The screen an action goes to, if it has one. */
export function actionTarget(action: Action): string | null {
  return "to" in action ? action.to : null;
}
