import { brotliDecompressSync, inflateSync } from "node:zlib";
import { FontError, readFontMeta, sniffFont } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import ttf from "./fixtures/InstrumentSans-Regular.ttf?inline";
import variable from "./fixtures/InstrumentSans-Variable.woff2?inline";
import woff from "./fixtures/InstrumentSerif-Italic.woff?inline";
import woff2 from "./fixtures/InstrumentSerif-Regular.woff2?inline";

const FIXTURES: Record<string, string> = {
  "InstrumentSans-Regular.ttf": ttf,
  "InstrumentSans-Variable.woff2": variable,
  "InstrumentSerif-Italic.woff": woff,
  "InstrumentSerif-Regular.woff2": woff2,
};
/** A fixture's bytes, from its Vite `?inline` data: URL. */
const fixture = (name: string) => {
  const url = FIXTURES[name] ?? "";
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
};
const node = {
  inflate: async (data: Uint8Array) => new Uint8Array(inflateSync(data)),
  brotli: async (data: Uint8Array) => new Uint8Array(brotliDecompressSync(data)),
};

describe("reading fonts", () => {
  it("knows formats by their first bytes", () => {
    expect(sniffFont(fixture("InstrumentSans-Regular.ttf"))).toBe("ttf");
    expect(sniffFont(fixture("InstrumentSerif-Italic.woff"))).toBe("woff");
    expect(sniffFont(fixture("InstrumentSerif-Regular.woff2"))).toBe("woff2");
    expect(sniffFont(new TextEncoder().encode("<svg>not a font</svg>"))).toBeNull();
  });

  it("reads a TrueType face", async () => {
    expect(await readFontMeta(fixture("InstrumentSans-Regular.ttf"), node)).toMatchObject({
      format: "ttf",
      family: "Instrument Sans",
      weight: 400,
      weightMax: null,
      italic: false,
      license: "OFL",
      restricted: false,
    });
  });

  it("reads an italic from a WOFF", async () => {
    expect(await readFontMeta(fixture("InstrumentSerif-Italic.woff"), node)).toMatchObject({
      format: "woff",
      family: "Instrument Serif",
      style: "Italic",
      italic: true,
    });
  });

  it("reads a WOFF2, and a variable font's weight range", async () => {
    expect(await readFontMeta(fixture("InstrumentSerif-Regular.woff2"), node)).toMatchObject({
      format: "woff2",
      family: "Instrument Serif",
      italic: false,
    });
    const variable = await readFontMeta(fixture("InstrumentSans-Variable.woff2"), node);
    expect(variable.family).toBe("Instrument Sans");
    expect([variable.weight, variable.weightMax]).toEqual([400, 700]);
  });

  it("refuses what isn't a font, or is damaged, with a sentence to act on", async () => {
    await expect(readFontMeta(new TextEncoder().encode("hello world!"), node)).rejects.toThrow(
      /isn't a font file/,
    );
    const cut = fixture("InstrumentSans-Regular.ttf").slice(0, 400);
    await expect(readFontMeta(cut, node)).rejects.toBeInstanceOf(FontError);
  });
});
