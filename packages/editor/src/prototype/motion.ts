/**
 * Motion for prototype transitions: easing curves (presets, cubic béziers and
 * springs), their CSS form, and the keyframes each transition plays on the
 * outgoing and incoming screens. Pure functions, so the player, the curve
 * editor and the tests share one definition.
 */
import type { Direction, Easing, Transition } from "@drawpane/model";

export type Bezier = readonly [x1: number, y1: number, x2: number, y2: number];

/** The cubic béziers behind the named easings; ease-out matches the design system's motion. */
export const EASING_PRESETS: Record<"linear" | "ease-in" | "ease-out" | "ease-in-out", Bezier> = {
  linear: [0, 0, 1, 1],
  "ease-in": [0.4, 0, 1, 1],
  "ease-out": [0.2, 0.8, 0.2, 1],
  "ease-in-out": [0.65, 0, 0.35, 1],
};

/** The bézier for any non-spring easing. */
export function bezierOf(easing: Easing): Bezier | null {
  switch (easing.type) {
    case "spring":
      return null;
    case "bezier":
      return [easing.x1, easing.y1, easing.x2, easing.y2];
    default:
      return EASING_PRESETS[easing.type];
  }
}

/** Point on a cubic bézier from (0,0) to (1,1) at parameter `t`. */
function bezierPoint(b: Bezier, t: number): { x: number; y: number } {
  const u = 1 - t;
  const a = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * b[0] + c * b[2] + d, y: a * b[1] + c * b[3] + d };
}

/** The curve's progress at time `x` (0..1), like CSS: solve x(t) = x, then read y(t). */
export function bezierAt(b: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // x(t) is monotonic because x1 and x2 are in [0, 1]: bisect.
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 40; i++) {
    const px = bezierPoint(b, t).x;
    if (Math.abs(px - x) < 1e-6) break;
    if (px < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return bezierPoint(b, t).y;
}

type Spring = Extract<Easing, { type: "spring" }>;

/** Spring presets, named the way the design system's motion tokens are. */
export const SPRING_PRESETS = {
  gentle: { type: "spring", mass: 1, stiffness: 120, damping: 18 },
  snappy: { type: "spring", mass: 1, stiffness: 320, damping: 24 },
  bouncy: { type: "spring", mass: 1, stiffness: 260, damping: 12 },
} as const satisfies Record<string, Spring>;

const SPRING_STEP_MS = 1000 / 240;
const SPRING_MAX_MS = 5000;

/**
 * Simulates a spring from 0 to 1 (semi-implicit Euler at 240 Hz) until it
 * settles within 0.1% and stops moving. Returns the samples, one per step.
 */
function simulateSpring(spring: Spring): number[] {
  const dt = SPRING_STEP_MS / 1000;
  let x = 0;
  let v = 0;
  const out = [0];
  for (let t = 0; t < SPRING_MAX_MS; t += SPRING_STEP_MS) {
    const a = (-spring.stiffness * (x - 1) - spring.damping * v) / spring.mass;
    v += a * dt;
    x += v * dt;
    out.push(x);
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break;
  }
  out[out.length - 1] = 1;
  return out;
}

const springCache = new Map<string, number[]>();
function springSamples(spring: Spring): number[] {
  const key = `${spring.mass}/${spring.stiffness}/${spring.damping}`;
  let samples = springCache.get(key);
  if (!samples) {
    samples = simulateSpring(spring);
    if (springCache.size > 64) springCache.clear();
    springCache.set(key, samples);
  }
  return samples;
}

/** How long a spring takes to settle, in milliseconds. */
export function springSettleMs(spring: Spring): number {
  return Math.round((springSamples(spring).length - 1) * SPRING_STEP_MS);
}

/** How long a transition plays, in milliseconds. */
export function transitionMs(transition: Transition): number {
  if (transition.type === "instant") return 0;
  return transition.easing.type === "spring"
    ? springSettleMs(transition.easing)
    : transition.duration;
}

/** Progress (may overshoot) at time fraction `x` for any easing. */
export function easingAt(easing: Easing, x: number): number {
  const bezier = bezierOf(easing);
  if (bezier) return bezierAt(bezier, x);
  const samples = springSamples(easing as Spring);
  const f = Math.min(1, Math.max(0, x)) * (samples.length - 1);
  const i = Math.floor(f);
  const a = samples[i] ?? 1;
  const b = samples[i + 1] ?? 1;
  return a + (b - a) * (f - i);
}

/** `n + 1` evenly spaced samples of the curve, for drawing it. */
export function sampleEasing(easing: Easing, n = 64): number[] {
  return Array.from({ length: n + 1 }, (_, i) => easingAt(easing, i / n));
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * The CSS timing function: `cubic-bezier(…)`, or for springs a `linear(…)`
 * curve sampled finely enough to look identical.
 */
export function easingCss(easing: Easing): string {
  const bezier = bezierOf(easing);
  if (bezier) return `cubic-bezier(${bezier.map(r4).join(", ")})`;
  const samples = springSamples(easing as Spring);
  // About 60 points is visually exact and keeps the string short.
  const stride = Math.max(1, Math.floor(samples.length / 60));
  const points: string[] = [];
  for (let i = 0; i < samples.length; i += stride) points.push(String(r4(samples[i] as number)));
  if ((samples.length - 1) % stride !== 0) points.push("1");
  return `linear(${points.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Keyframes

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface TransitionFrames {
  /** Keyframes for the screen arriving, or null when it simply appears. */
  readonly incoming: Keyframe[] | null;
  /** Keyframes for the screen leaving, or null when it stays put underneath. */
  readonly outgoing: Keyframe[] | null;
  /** Which screen paints on top while the transition plays. */
  readonly top: "incoming" | "outgoing";
}

const VECTOR: Record<Direction, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

/** How far the screen underneath drifts in a slide, as a share of the screen. */
const PARALLAX = 0.3;

function translate(direction: Direction, size: Size, amount: number): string {
  const v = VECTOR[direction];
  return `translate(${r4(v.x * size.width * amount)}px, ${r4(v.y * size.height * amount)}px)`;
}

/**
 * What each screen does during a transition. The direction is where the motion
 * goes: "move in, left" slides the new screen in from the right edge.
 */
export function transitionFrames(transition: Transition, size: Size): TransitionFrames {
  const d = transition.direction;
  const from = (amount: number) => translate(d, size, -amount);
  const to = (amount: number) => translate(d, size, amount);
  const still = "translate(0px, 0px)";
  switch (transition.type) {
    case "instant":
      return { incoming: null, outgoing: null, top: "incoming" };
    case "dissolve":
      return { incoming: [{ opacity: 0 }, { opacity: 1 }], outgoing: null, top: "incoming" };
    case "move-in":
      return {
        incoming: [{ transform: from(1) }, { transform: still }],
        outgoing: null,
        top: "incoming",
      };
    case "move-out":
      return {
        incoming: null,
        outgoing: [{ transform: still }, { transform: to(1) }],
        top: "outgoing",
      };
    case "push":
      return {
        incoming: [{ transform: from(1) }, { transform: still }],
        outgoing: [{ transform: still }, { transform: to(1) }],
        top: "incoming",
      };
    case "slide-in":
      return {
        incoming: [{ transform: from(1) }, { transform: still }],
        outgoing: [{ transform: still }, { transform: to(PARALLAX) }],
        top: "incoming",
      };
    case "slide-out":
      return {
        incoming: [{ transform: from(PARALLAX) }, { transform: still }],
        outgoing: [{ transform: still }, { transform: to(1) }],
        top: "outgoing",
      };
  }
}

const OPPOSITE: Record<Direction, Direction> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up",
};

/**
 * The transition that undoes another, for Back: a screen that moved in from
 * the right moves out to the right.
 */
export function reverseTransition(transition: Transition): Transition {
  const direction = OPPOSITE[transition.direction];
  switch (transition.type) {
    case "move-in":
      return { ...transition, type: "move-out", direction };
    case "move-out":
      return { ...transition, type: "move-in", direction };
    case "slide-in":
      return { ...transition, type: "slide-out", direction };
    case "slide-out":
      return { ...transition, type: "slide-in", direction };
    case "push":
      return { ...transition, direction };
    default:
      return transition;
  }
}
