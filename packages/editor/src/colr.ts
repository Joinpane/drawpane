/** A COLRv0 layer uses a palette entry or the current text paint. */
export interface ColorLayer {
  readonly glyph: number;
  readonly color: string | null;
}

/** The default palette and paint order of a layered TrueType colour face. */
export function colorLayers(
  colrBytes: Uint8Array | undefined,
  cpalBytes: Uint8Array | undefined,
): ReadonlyMap<number, readonly ColorLayer[]> {
  const byGlyph = new Map<number, ColorLayer[]>();
  if (!colrBytes || colrBytes.length < 14 || !cpalBytes || cpalBytes.length < 14) return byGlyph;
  const colr = new DataView(colrBytes.buffer, colrBytes.byteOffset, colrBytes.byteLength);
  const cpal = new DataView(cpalBytes.buffer, cpalBytes.byteOffset, cpalBytes.byteLength);
  if (colr.getUint16(0) !== 0 || cpal.getUint16(4) === 0) return byGlyph;

  const glyphCount = colr.getUint16(2);
  const bases = colr.getUint32(4);
  const layers = colr.getUint32(8);
  const layerCount = colr.getUint16(12);
  const colors = cpal.getUint32(8) + cpal.getUint16(12) * 4;
  const colorCount = cpal.getUint16(2);
  if (
    bases + glyphCount * 6 > colr.byteLength ||
    layers + layerCount * 4 > colr.byteLength ||
    colors + colorCount * 4 > cpal.byteLength
  )
    return byGlyph;

  const palette = Array.from({ length: colorCount }, (_, index) => {
    const at = colors + index * 4;
    const [red, green, blue, alpha] = [2, 1, 0, 3].map((byte) =>
      cpal
        .getUint8(at + byte)
        .toString(16)
        .padStart(2, "0"),
    );
    return `#${red}${green}${blue}${alpha}`;
  });
  for (let index = 0; index < glyphCount; index++) {
    const at = bases + index * 6;
    const first = colr.getUint16(at + 2);
    const count = colr.getUint16(at + 4);
    if (count === 0 || first + count > layerCount) continue;
    const ordered: ColorLayer[] = [];
    for (let layer = first; layer < first + count; layer++) {
      const offset = layers + layer * 4;
      const entry = colr.getUint16(offset + 2);
      if (entry === 0xffff || entry < colorCount)
        ordered.push({ glyph: colr.getUint16(offset), color: palette[entry] ?? null });
    }
    if (ordered.length > 0) byGlyph.set(colr.getUint16(at), ordered);
  }
  return byGlyph;
}
