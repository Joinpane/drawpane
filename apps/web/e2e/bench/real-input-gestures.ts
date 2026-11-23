import { setTimeout as sleep } from "node:timers/promises";
import type { CDPSession } from "@playwright/test";

// CDP modifier bits.
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const TRACKPAD_PERIOD_MS = 1000 / 120;

type Delta = { dx: number; dy: number };
type WheelSample = Delta & { offset: number; modifiers: number };
type Gesture = { name: string; gate?: boolean } & (
  | { wheel: WheelSample[]; digit?: never }
  | { digit: 0 | 1 | 2; wheel?: never }
);

function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const fractional = (n: number) => Math.round(n * 1000) / 1000;

/** The audit's two-finger swipe: ramp up, hold for 400 ms, then decay through momentum. */
function swipe(dirX: number, dirY: number, peak: number, seed: number): Delta[] {
  const rng = random(seed);
  const deltas: Delta[] = [];
  for (let i = 0; i < 48; i++) {
    const v = peak * Math.min(1, (i + 1) / 12) * (0.93 + 0.14 * rng());
    deltas.push({ dx: fractional(dirX * v + 0.01), dy: fractional(dirY * v + 0.01) });
  }
  for (let v = peak; v > 0.15; ) {
    v *= 0.968;
    deltas.push({
      dx: fractional(dirX * v * (0.97 + 0.06 * rng())),
      dy: fractional(dirY * v * (0.97 + 0.06 * rng())),
    });
  }
  return deltas;
}

/** A pinch rides a bell-shaped curve whose fractional deltas sum to the target zoom. */
function pinch(total: number, ms: number, seed: number): Delta[] {
  const rng = random(seed);
  const n = Math.round(ms / TRACKPAD_PERIOD_MS);
  const weights = Array.from(
    { length: n },
    (_, i) => Math.sin((Math.PI * (i + 0.5)) / n) * (0.85 + 0.3 * rng()),
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => ({ dx: 0, dy: fractional((w / sum) * total) }));
}

function wheel(deltas: Delta[], modifiers = 0, period = TRACKPAD_PERIOD_MS): WheelSample[] {
  return deltas.map((delta, i) => ({ ...delta, offset: i * period, modifiers }));
}

function swipes(gap: number, parts: Delta[][]): WheelSample[] {
  let start = 0;
  return parts.flatMap((deltas) => {
    const part = wheel(deltas).map((sample) => ({ ...sample, offset: sample.offset + start }));
    start += (deltas.length - 1) * TRACKPAD_PERIOD_MS + gap;
    return part;
  });
}

function notches(dy: number): WheelSample[] {
  return wheel(
    Array.from({ length: 6 }, () => ({ dx: 0, dy })),
    META,
    80,
  );
}

// Keep the audit's order: zoom out from the high-zoom board, and pan at the scale
// set by Shift+0. Only the first camera position comes from the board link.
export const gestures: Gesture[] = [
  { name: "Pinch in on a board", wheel: wheel(pinch(-139, 1000, 11), CTRL) },
  { name: "Pinch out on a board", wheel: wheel(pinch(208, 1200, 12), CTRL), gate: true },
  { name: "Shift+1 fit", digit: 1 },
  {
    name: "Trackpad pan at fit",
    wheel: swipes(500, [swipe(1, 0.45, 8, 21), swipe(-1, -0.45, 8, 22)]),
  },
  { name: "Pinch from fit", wheel: wheel(pinch(-340, 2500, 13), CTRL) },
  { name: "Shift+2 selection", digit: 2 },
  { name: "Shift+0 100%", digit: 0 },
  {
    name: "Trackpad pan across boards at 100%",
    wheel: swipes(300, [swipe(1, 0.04, 20, 31), swipe(1, -0.04, 20, 32), swipe(1, 0.02, 20, 33)]),
    gate: true,
  },
  { name: "Cmd+scroll out", wheel: notches(100), gate: true },
  { name: "Cmd+scroll in", wheel: notches(-100), gate: true },
];

const nowEpoch = () => performance.timeOrigin + performance.now();

export async function replay(
  cdp: CDPSession,
  gesture: Gesture,
  point: { x: number; y: number; dpr: number },
) {
  if (!gesture.wheel) {
    const shift = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
    const digit = gesture.digit;
    const key = {
      key: { 0: ")", 1: "!", 2: "@" }[digit],
      code: `Digit${digit}`,
      windowsVirtualKeyCode: 48 + digit,
    };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shift, modifiers: SHIFT });
    const sent = nowEpoch();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...key,
      modifiers: SHIFT,
      timestamp: sent / 1000,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key, modifiers: SHIFT });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...shift });
    return { start: sent, stop: sent };
  }

  const { x, y, dpr } = point;
  const start = nowEpoch();
  let stop = start;
  let error: unknown;
  const pending: Promise<unknown>[] = [];
  for (const { offset, dx, dy, modifiers } of gesture.wheel) {
    let remaining = start + offset - nowEpoch();
    while (remaining >= 1) {
      await sleep(remaining);
      remaining = start + offset - nowEpoch();
    }
    stop = nowEpoch();
    // Chromium divides CDP wheel deltas by DPR before the DOM sees them.
    pending.push(
      cdp
        .send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: dx * dpr,
          deltaY: dy * dpr,
          modifiers,
          timestamp: stop / 1000,
        })
        .catch((cause: unknown) => {
          error ??= cause;
        }),
    );
  }
  // The send clock stops before waiting for Chrome. A slow page can keep receiving
  // wheel events during this wait, across swipes as well as within a swipe.
  await Promise.all(pending);
  if (error) throw error;
  return { start, stop };
}
