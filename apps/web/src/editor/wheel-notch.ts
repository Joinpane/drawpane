/**
 * A wheel step of at least this many whole pixels (or a line or page) is a notch: a mouse wheel's,
 * or a step of Cmd+scroll. A trackpad sends small fractional deltas many times a frame.
 */
const NOTCH_MIN_PX = 40;

type Wheel = Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "timeStamp">;

/** Whether a wheel event is a notch (`NOTCH_MIN_PX`). */
export function isNotch(e: Wheel): boolean {
  if (e.deltaMode !== 0) return true;
  const step = (d: number) => Number.isInteger(d) && Math.abs(d) >= NOTCH_MIN_PX;
  return step(e.deltaY) || step(e.deltaX);
}

/**
 * Until when the camera counts as moving after wheel event `e`, given the wait so far (`until`,
 * `performance.now()` time). More notches usually follow one, so the view isn't at rest until
 * `settleMs` passes after the last: refining between notches would only be thrown away at the
 * next, and the GPU work it queues would hold that notch's frame back. The wait runs from when
 * the event happened, not when it was handled (notches handled together after a stall are still
 * apart), and only ever grows: a trackpad's stream leaves it as it is.
 */
export function settleAfterNotch(until: number, e: Wheel, settleMs: number): number {
  if (!isNotch(e)) return until;
  const at = e.timeStamp > 0 ? e.timeStamp : performance.now();
  return Math.max(until, at + settleMs);
}
