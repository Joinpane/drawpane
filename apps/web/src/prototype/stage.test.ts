import { describe, expect, it } from "vitest";
import { deviceRoom } from "./stage";

describe("the room a device has on the stage", () => {
  it("keeps the device clear of the hint pill along the bottom", () => {
    // A laptop window's stage: 48px above, and 60px below for the hint (16 up, 28 tall, 16 of air).
    const room = deviceRoom(1196, 846);
    expect(room.width).toBe(1196 - 96);
    expect(room.height).toBe(846 - 48 - 60);
    // The device centres in what's left: its bottom margin makes up the difference.
    expect(room.lift).toBe(12);
  });

  it("keeps the hint's room on a narrow window too", () => {
    const room = deviceRoom(560, 700);
    expect(room.width).toBe(560 - 32);
    expect(room.height).toBe(700 - 16 - 60);
    expect(room.lift).toBe(44);
  });

  it("never leaves less than a usable box", () => {
    expect(deviceRoom(120, 90)).toMatchObject({ width: 100, height: 100 });
  });
});
