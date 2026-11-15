import { afterEach, describe, expect, it, vi } from "vitest";
import { facesOffered } from "./font-files";
import type { FontFamily } from "./fonts";

const instrument: FontFamily = {
  family: "Instrument Sans",
  source: "bundled",
  category: "Sans Serif",
  weights: [400, 500, 600, 700],
  italics: [400, 500, 600, 700],
  variable: true,
};

afterEach(() => vi.restoreAllMocks());

describe("facesOffered", () => {
  it("asks for a variable family's weights inside its range, which is all Google has", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      asked.push(String(input));
      return new Response("");
    });
    await facesOffered(
      "Instrument Sans",
      instrument,
      [
        { family: "Instrument Sans", weight: 800, italic: false },
        { family: "Instrument Sans", weight: 650, italic: true },
        { family: "Instrument Sans", weight: 300, italic: false },
      ],
      ["ttf"],
    );
    expect(new URL(asked[0] ?? "", "http://x").searchParams.get("variants")).toBe("700,650i,400");
  });
});
