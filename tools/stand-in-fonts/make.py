"""
Builds the fonts the font-alias tests use (decision 0034), from OFL fonts
already in the repo. Apple's SF fonts are licensed and never committed, so
tests use stand-ins that carry Apple's family names:

- "SF Pro Text" Regular and Bold: Instrument Sans, renamed, with one
  SF Symbols-style glyph at U+100185 (a filled circle, 1.25 em wide).
- "SF Pro Display" Regular: Inter at weight 400, renamed. It has no symbol
  glyph, so text set in it shows the missing-glyph box instead.
- "Drawpane Missing Glyph": one box glyph mapped to every private-use code
  point (cmap format 13, as Apple's Last Resort font does). The editor puts
  it right after a text's own family, so a symbol its font lacks draws as a
  box rather than as whatever a fallback font has there.

Run with fontTools (pip install fonttools):

    python3 tools/stand-in-fonts/make.py
"""

import base64
import sys
from pathlib import Path

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.varLib import instancer
from fontTools.fontBuilder import FontBuilder

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "apps/web/e2e/fixtures"
SYMBOL = 0x100185


def rename(font: TTFont, family: str, style: str) -> None:
    name = font["name"]
    full = f"{family} {style}" if style != "Regular" else family
    ps = f"{family.replace(' ', '')}StandIn-{style.replace(' ', '')}"
    for record in list(name.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=record.nameID)
    legacy_style = style if style in ("Regular", "Bold", "Italic", "Bold Italic") else "Regular"
    name.setName(family, 1, 3, 1, 0x409)
    name.setName(legacy_style, 2, 3, 1, 0x409)
    name.setName(f"{ps};stand-in", 3, 3, 1, 0x409)
    name.setName(full, 4, 3, 1, 0x409)
    name.setName(ps, 6, 3, 1, 0x409)
    name.setName(family, 16, 3, 1, 0x409)
    name.setName(style, 17, 3, 1, 0x409)
    name.setName(
        "A stand-in for tests, made from an SIL Open Font License font. Not Apple's font.",
        10,
        3,
        1,
        0x409,
    )


def add_symbol(font: TTFont) -> None:
    """A filled circle at U+100185, 1.25 em wide: easy to tell from the missing-glyph box."""
    upem = font["head"].unitsPerEm
    advance = round(upem * 1.25)
    pen = TTGlyphPen(None)
    r = upem * 0.45
    cx, cy = advance / 2, upem * 0.35
    pen.moveTo((cx + r, cy))
    pen.qCurveTo((cx + r, cy + r), (cx, cy + r))
    pen.qCurveTo((cx - r, cy + r), (cx - r, cy))
    pen.qCurveTo((cx - r, cy - r), (cx, cy - r))
    pen.qCurveTo((cx + r, cy - r), (cx + r, cy))
    pen.closePath()
    glyph = pen.glyph()
    name = "uni100185"
    order = font.getGlyphOrder() + [name]
    font.setGlyphOrder(order)
    font["glyf"][name] = glyph
    glyph.recalcBounds(font["glyf"])
    font["hmtx"][name] = (advance, glyph.xMin)
    font["maxp"].numGlyphs = len(order)
    cmap = font["cmap"]
    big = cmap.getcmap(3, 10)
    if big is None:
        big = CmapSubtable.newSubtable(12)
        big.platformID, big.platEncID, big.language = 3, 10, 0
        big.cmap = dict(cmap.getBestCmap())
        cmap.tables.append(big)
    big.cmap[SYMBOL] = name
    if "post" in font and font["post"].formatType == 2.0:
        font["post"].extraNames = getattr(font["post"], "extraNames", [])
    for drop in ("hdmx", "LTSH", "VDMX", "DSIG"):
        if drop in font:
            del font[drop]


def set_weight(font: TTFont, weight: int, bold: bool) -> None:
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b100000 if bold else 0b1000000)
    font["head"].macStyle = 1 if bold else 0


def text_face(style: str, weight: int) -> None:
    source = TTFont(FIXTURES / "InstrumentSans-Variable.ttf")
    axes = {a.axisTag: a.defaultValue for a in source["fvar"].axes}
    axes["wght"] = weight
    font = instancer.instantiateVariableFont(source, axes)
    rename(font, "SF Pro Text", style)
    set_weight(font, weight, weight >= 700)
    add_symbol(font)
    out = FIXTURES / f"SFProText-StandIn-{style.replace(' ', '')}.ttf"
    font.save(out)
    print(out.relative_to(ROOT), out.stat().st_size)


def display_face() -> None:
    source = TTFont(FIXTURES / "Inter-Variable.ttf")
    axes = {a.axisTag: a.defaultValue for a in source["fvar"].axes}
    axes["wght"] = 400
    font = instancer.instantiateVariableFont(source, axes)
    rename(font, "SF Pro Display", "Regular")
    set_weight(font, 400, False)
    for drop in ("hdmx", "LTSH", "VDMX", "DSIG"):
        if drop in font:
            del font[drop]
    out = FIXTURES / "SFProDisplay-StandIn-Regular.ttf"
    font.save(out)
    print(out.relative_to(ROOT), out.stat().st_size)


PRIVATE_USE = [(0xE000, 0xF8FF), (0xF0000, 0xFFFFD), (0x100000, 0x10FFFD)]


def missing_glyph() -> bytes:
    """One box (an outlined rectangle), 0.7 em wide, for every private-use code point."""
    upem = 1000
    fb = FontBuilder(upem, isTTF=True)
    fb.setupGlyphOrder([".notdef", "box"])
    # Format 13 maps whole ranges to one glyph; fontBuilder writes 4 and 12, so it's added below.
    fb.setupCharacterMap({0xE000: "box"})

    def box(pen: TTGlyphPen) -> None:
        x0, x1, y0, y1, t = 90, 610, 0, 720, 70
        pen.moveTo((x0, y0))
        pen.lineTo((x0, y1))
        pen.lineTo((x1, y1))
        pen.lineTo((x1, y0))
        pen.closePath()
        pen.moveTo((x0 + t, y0 + t))
        pen.lineTo((x1 - t, y0 + t))
        pen.lineTo((x1 - t, y1 - t))
        pen.lineTo((x0 + t, y1 - t))
        pen.closePath()

    glyphs = {}
    for name in (".notdef", "box"):
        pen = TTGlyphPen(None)
        box(pen)
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({".notdef": (700, 90), "box": (700, 90)})
    fb.setupHorizontalHeader(ascent=900, descent=-250)
    fb.setupNameTable(
        {
            "familyName": "Drawpane Missing Glyph",
            "styleName": "Regular",
            "uniqueFontIdentifier": "DrawpaneMissingGlyph-Regular",
            "fullName": "Drawpane Missing Glyph",
            "psName": "DrawpaneMissingGlyph-Regular",
            "version": "Version 1.000",
            "licenseDescription": "Drawpane's own, under the project's license.",
        }
    )
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-250, usWinAscent=900, usWinDescent=250)
    fb.setupPost()
    font = fb.font
    many = CmapSubtable.newSubtable(13)
    many.platformID, many.platEncID, many.language = 3, 10, 0
    many.cmap = {}
    for first, last in PRIVATE_USE:
        for cp in range(first, last + 1):
            many.cmap[cp] = "box"
    font["cmap"].tables = [t for t in font["cmap"].tables if t.format == 4] + [many]
    path = Path("/tmp/drawpane-missing-glyph.ttf")
    font.save(path)
    return path.read_bytes()


def write_module(data: bytes) -> None:
    out = ROOT / "packages/editor/src/missing-glyph-font.ts"
    b64 = base64.b64encode(data).decode()
    lines = [b64[i : i + 96] for i in range(0, len(b64), 96)]
    body = "\n".join(f'  "{line}",' for line in lines)
    ranges = "\n".join(f"  [0x{a:X}, 0x{b:X}]," for a, b in PRIVATE_USE)
    out.write_text(
        """/**
 * "Drawpane Missing Glyph": one box glyph for every private-use code point
 * (decision 0034). Text lists it right after its own family, so a symbol
 * (SF Symbols are private-use characters in Apple's SF fonts) that the font
 * at hand lacks draws as a box, never as whatever a fallback font has there.
 * The canvas, the HarfBuzz measurer and the headless renderer all use these
 * bytes. Written by tools/stand-in-fonts/make.py; don't edit by hand.
 */

export const MISSING_GLYPH_FAMILY = "Drawpane Missing Glyph";

/** The code points it covers, as [first, last]: the three private-use areas. */
export const PRIVATE_USE_RANGES: ReadonlyArray<readonly [number, number]> = [
@RANGES@
];

const BASE64 = [
@BODY@
].join("");

/** Whether a code point is private use: what the box font covers. */
export const isPrivateUse = (cp: number): boolean =>
  PRIVATE_USE_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** The CSS unicode-range of what it covers, for @font-face and `FontFace`. */
export const PRIVATE_USE_UNICODE_RANGE = PRIVATE_USE_RANGES.map(
  ([a, b]) => `U+${a.toString(16).toUpperCase()}-${b.toString(16).toUpperCase()}`,
).join(", ");

/**
 * The font file (TrueType), decoded on first use. The same buffer each time
 * (HarfBuzz faces are shared by buffer): don't write to it.
 */
let bytes: ArrayBuffer | null = null;
export function missingGlyphFont(): ArrayBuffer {
  if (!bytes) {
    const text = atob(BASE64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    bytes = out.buffer;
  }
  return bytes;
}
"""
        .replace("@RANGES@", ranges)
        .replace("@BODY@", body)
    )
    print(out.relative_to(ROOT), len(data), "bytes")


if __name__ == "__main__":
    what = set(sys.argv[1:]) or {"fixtures", "missing"}
    if "fixtures" in what:
        text_face("Regular", 400)
        text_face("Bold", 700)
        display_face()
    if "missing" in what:
        write_module(missing_glyph())
