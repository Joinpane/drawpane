import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { utf8Length } from "../src/index";

// The model has no DOM or Node types; the test runner has TextEncoder all the same.
const { TextEncoder: Encoder } = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): { length: number } };
};
const encoded = (text: string) => new Encoder().encode(text).length;

describe("utf8Length", () => {
  it("counts what TextEncoder writes", () => {
    for (const text of [
      "",
      "plain ascii",
      "café",
      "界".repeat(10),
      "😀👍🏽",
      "a\nb\u0000c",
      // Lone surrogates are written as U+FFFD, three bytes.
      "\ud800",
      "x\udc00y",
      "\ud83d",
      "\ud83d😀",
    ])
      expect(utf8Length(text), JSON.stringify(text)).toBe(encoded(text));
  });

  it("agrees with TextEncoder on any string", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 64 }),
        (text) => utf8Length(text) === encoded(text),
      ),
    );
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
          maxLength: 64,
        }),
        (text) => utf8Length(text) === encoded(text),
      ),
    );
  });
});
