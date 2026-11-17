/**
 * The file's records (with their style links applied, see styles.ts), for
 * what Open Pencil's scene graph (0.16) doesn't keep: a layer's own kind
 * (unknown kinds become rectangles there), the settings of noise, texture
 * and progressive blur effects, image adjustments, line heights in percent,
 * a font's style name, whether a mask was saved with a type, a page's
 * background, and what slots hold (slots.ts). Only the fields read here are
 * typed.
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
  /** Figma's own layout of the text when it was saved: each line's height, among others. */
  readonly derivedTextData?: {
    readonly baselines?: readonly { readonly lineHeight?: number }[];
  };
  readonly maskType?: string;
  readonly parentIndex?: { readonly guid?: RawGuid; readonly position?: string };
  readonly overrideKey?: RawGuid;
  readonly componentPropRefs?: readonly RawPropRef[];
  readonly componentPropAssignments?: readonly RawPropAssignment[];
  readonly symbolData?: {
    /** The component an instance copies. */
    readonly symbolID?: RawGuid;
    readonly symbolOverrides?: readonly {
      readonly guidPath?: { readonly guids?: readonly RawGuid[] };
      readonly componentPropAssignments?: readonly RawPropAssignment[];
    }[];
  };
  // Grid auto layout (`stackMode: "GRID"`), which Open Pencil's graph (0.16) reads as none.
  readonly stackMode?: string;
  /** The grid's tracks, each an id ordered by its position. */
  readonly gridRows?: RawTrackOrder;
  readonly gridColumns?: RawTrackOrder;
  /** Each track's size, by id. */
  readonly gridRowsSizing?: RawTrackSizes;
  readonly gridColumnsSizing?: RawTrackSizes;
  readonly gridRowGap?: number;
  readonly gridColumnGap?: number;
  /** Items flow in order, as added rows take them. */
  readonly gridReflowEnabled?: boolean;
  /** A grid item's first row and column (track ids), and how many it spans. */
  readonly gridRowAnchor?: RawGuid;
  readonly gridColumnAnchor?: RawGuid;
  readonly gridRowSpan?: number;
  readonly gridColumnSpan?: number;
  readonly gridChildHorizontalAlign?: string;
  readonly gridChildVerticalAlign?: string;
}

export interface RawTrackOrder {
  readonly entries?: readonly { readonly id?: RawGuid; readonly position?: string }[];
}

/** How a grid track sizes: Figma's FIXED (px), FLEX (fr) or HUG (auto), between a min and a max. */
export interface RawTrackSizing {
  readonly type?: "FIXED" | "FLEX" | "HUG";
  readonly value?: number;
}

export interface RawTrackSizes {
  readonly entries?: readonly {
    readonly id?: RawGuid;
    readonly trackSize?: {
      readonly minSizing?: RawTrackSizing;
      readonly maxSizing?: RawTrackSizing;
    };
  }[];
}

/** A layer's link to a component property: which of its fields the property sets. */
export interface RawPropRef {
  readonly defID?: RawGuid;
  readonly componentPropNodeField?: string;
  readonly isDeleted?: boolean;
}

/** An instance's value for a component property (only slot content is typed). */
export interface RawPropAssignment {
  readonly defID?: RawGuid;
  readonly varValue?: {
    readonly value?: { readonly slotContentIdValue?: { readonly guid?: RawGuid } };
  };
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
