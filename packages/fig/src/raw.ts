/**
 * The file's records (with their style links applied, see styles.ts), for
 * what Open Pencil's scene graph (0.16) doesn't keep: a layer's own kind
 * (unknown kinds become rectangles there), the settings of noise, texture
 * and progressive blur effects, image adjustments, line heights in percent,
 * a font's style name, whether a mask was saved with a type, a page's
 * background. Only the fields read here are typed.
 */
import type { Figma } from "@drawpane/figma";

export interface RawGuid {
  readonly sessionID: number;
  readonly localID: number;
}

export interface RawPaint {
  readonly type?: string;
  readonly image?: { readonly hash?: unknown };
  readonly paintFilter?: Readonly<Record<string, number>>;
  readonly filterColorAdjust?: Readonly<Record<string, number>>;
}

export interface RawEffect {
  readonly type?: string;
  readonly radius?: number;
  readonly blurOpType?: string;
  readonly noiseType?: "MONOTONE" | "DUOTONE" | "MULTITONE";
  readonly noiseSize?: Figma.Vector;
  readonly density?: number;
  readonly secondaryColor?: Figma.RGBA;
  readonly color?: Figma.RGBA;
  readonly opacity?: number;
  readonly clipToShape?: boolean;
}

export interface RawNumber {
  readonly value?: number;
  readonly units?: "RAW" | "PIXELS" | "PERCENT";
}

export interface RawRecord {
  readonly guid?: RawGuid;
  readonly type?: string;
  readonly phase?: string;
  readonly backgroundColor?: Figma.RGBA;
  readonly fillPaints?: readonly RawPaint[];
  readonly strokePaints?: readonly RawPaint[];
  readonly effects?: readonly RawEffect[];
  readonly lineHeight?: RawNumber;
  readonly fontName?: {
    readonly family?: string;
    readonly style?: string;
    readonly postscript?: string;
  };
  readonly fontSize?: number;
  readonly textCase?: string;
  readonly maskType?: string;
}

export const guidString = (g: RawGuid) => `${g.sessionID}:${g.localID}`;

/** Every live record by its guid ("session:local"). */
export function indexRecords(records: readonly RawRecord[]): Map<string, RawRecord> {
  const out = new Map<string, RawRecord>();
  for (const r of records) if (r.guid && r.phase !== "REMOVED") out.set(guidString(r.guid), r);
  return out;
}

/** A raw paint's image ref: its 20-byte SHA-1 as hex, however the decoder handed the bytes over. */
export function rawImageRef(p: RawPaint | undefined): string | null {
  const hash = p?.image?.hash;
  if (!hash || typeof hash !== "object") return null;
  const bytes =
    hash instanceof Uint8Array
      ? [...hash]
      : Object.keys(hash)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => (hash as Record<string, number>)[k] as number);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
