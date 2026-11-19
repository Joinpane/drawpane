import { describe, expect, it } from "vitest";
import { Encoder, MAGIC, OP, Path, parseSvgPath } from "../src/encode";

const words = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
};

describe("the display list's wire format", () => {
  it("starts with its magic, version and size", () => {
    const w = words(new Encoder(880, 2168).bytes());
    expect(w).toEqual([MAGIC, 1, 880, 2168]);
  });

  it("writes a fill as its opcode, transform, path, rule and colour", () => {
    const out = new Encoder(10, 10);
    out.fill(
      [2, 0, 0, 2, 0, 0],
      new Path().moveTo(0, 0).lineTo(4, 0).close(),
      true,
      [1, 0, 0, 0.5],
    );
    const bytes = out.bytes();
    const view = new DataView(bytes.buffer);
    let at = 16;
    const u32 = () => {
      const v = view.getUint32(at, true);
      at += 4;
      return v;
    };
    const f32 = () => {
      const v = view.getFloat32(at, true);
      at += 4;
      return v;
    };
    expect(u32()).toBe(OP.fill);
    expect([f32(), f32(), f32(), f32(), f32(), f32()]).toEqual([2, 0, 0, 2, 0, 0]);
    expect(u32()).toBe(3); // verbs
    expect([u32(), f32(), f32()]).toEqual([0, 0, 0]);
    expect([u32(), f32(), f32()]).toEqual([1, 4, 0]);
    expect(u32()).toBe(4); // close
    expect(u32()).toBe(1); // even-odd
    expect([f32(), f32(), f32(), f32()]).toEqual([1, 0, 0, 0.5]);
    expect(at).toBe(bytes.length);
    expect(out.counts.get(OP.fill)).toBe(1);
  });

  it("grows past its first buffer", () => {
    const out = new Encoder(1, 1);
    const p = new Path();
    for (let i = 0; i < 10_000; i++) p.lineTo(i, i);
    out.fill([1, 0, 0, 1, 0, 0], p, false, [0, 0, 0, 1]);
    expect(out.bytes().length).toBeGreaterThan(1 << 16);
  });
});

describe("SVG path data, as the editor writes outlines", () => {
  it("reads absolute moves, lines, curves and closes", () => {
    const p = parseSvgPath("M0 0L10 0Q12 0 12 2C12 4 10 6 8 6Z");
    expect(p.verbs).toEqual([0, 1, 2, 3, 4]);
    expect(p.coords).toEqual([0, 0, 10, 0, 12, 0, 12, 2, 12, 4, 10, 6, 8, 6]);
  });

  it("turns H and V into lines from the current point", () => {
    const p = parseSvgPath("M1 2H5V7");
    expect(p.verbs).toEqual([0, 1, 1]);
    expect(p.coords).toEqual([1, 2, 5, 2, 5, 7]);
  });

  it("reads further pairs after a move as lines", () => {
    const p = parseSvgPath("M0 0 3 4 5 6");
    expect(p.verbs).toEqual([0, 1, 1]);
  });
});
