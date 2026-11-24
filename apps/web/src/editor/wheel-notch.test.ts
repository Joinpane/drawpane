import { describe, expect, it } from "vitest";
import { isNotch, settleAfterNotch } from "./wheel-notch";

const wheel = (deltaY: number, timeStamp: number, deltaMode = 0) => ({
  deltaMode,
  deltaX: 0,
  deltaY,
  timeStamp,
});

describe("wheel notches", () => {
  it("tells a notch from a trackpad's stream", () => {
    expect(isNotch(wheel(100, 0))).toBe(true);
    expect(isNotch(wheel(-120, 0))).toBe(true);
    expect(isNotch(wheel(3, 0, 1))).toBe(true);
    expect(isNotch(wheel(12.375, 0))).toBe(false);
    expect(isNotch(wheel(4, 0))).toBe(false);
  });

  it("waits past the last notch by when it happened, however they're handled", () => {
    // Six Cmd+scroll notches 80 ms apart, handled together after a stall: the wait is set from
    // their own times, never cleared by two arriving close together.
    let until = 0;
    for (let k = 0; k < 6; k++) until = settleAfterNotch(until, wheel(100, 1000 + 80 * k), 120);
    expect(until).toBe(1000 + 80 * 5 + 120);
    // Events handled out of order never shorten it.
    expect(settleAfterNotch(until, wheel(100, 1100), 120)).toBe(until);
  });

  it("leaves a trackpad's stream without a wait", () => {
    let until = 0;
    for (let k = 0; k < 30; k++)
      until = settleAfterNotch(until, wheel(7.25 + k / 8, 500 + 8 * k), 120);
    expect(until).toBe(0);
    // A stream doesn't clear a notch's wait either.
    until = settleAfterNotch(0, wheel(100, 2000), 120);
    expect(settleAfterNotch(until, wheel(3.5, 2010), 120)).toBe(2120);
  });
});
