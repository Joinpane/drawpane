/**
 * The parts of Figma's REST API file format (GET /v1/files/:key with
 * `geometry=paths`) the converter reads. Figma's own OpenAPI spec
 * (figma/rest-api-spec) is the reference; fields are optional here because
 * files from older versions, and node types that don't have them, leave
 * them out. Anything not listed is read loosely, where it's read at all.
 */

export interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Vector {
  readonly x: number;
  readonly y: number;
}

/** [[a, c, e], [b, d, f]]: x' = a·x + c·y + e, y' = b·x + d·y + f, relative to the parent. */
export type Transform = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
];

export interface ColorStop {
  readonly position: number;
  readonly color: RGBA;
}

export interface Paint {
  readonly type:
    | "SOLID"
    | "GRADIENT_LINEAR"
    | "GRADIENT_RADIAL"
    | "GRADIENT_ANGULAR"
    | "GRADIENT_DIAMOND"
    | "IMAGE"
    | "EMOJI"
    | "VIDEO"
    | "PATTERN";
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly blendMode?: string;
  readonly color?: RGBA;
  /** Gradients: start, end, and the width handle, in the layer's unit square. */
  readonly gradientHandlePositions?: readonly Vector[];
  readonly gradientStops?: readonly ColorStop[];
  readonly scaleMode?: "FILL" | "FIT" | "TILE" | "STRETCH";
  readonly imageRef?: string;
  readonly imageTransform?: Transform;
  readonly scalingFactor?: number;
  readonly rotation?: number;
  readonly filters?: Readonly<Record<string, number>>;
}

export interface Effect {
  readonly type:
    | "DROP_SHADOW"
    | "INNER_SHADOW"
    | "LAYER_BLUR"
    | "BACKGROUND_BLUR"
    | "NOISE"
    | "TEXTURE"
    | "GLASS";
  readonly visible?: boolean;
  readonly color?: RGBA;
  readonly offset?: Vector;
  readonly radius?: number;
  readonly spread?: number;
  readonly blendMode?: string;
  readonly showShadowBehindNode?: boolean;
  readonly blurType?: "NORMAL" | "PROGRESSIVE";
  readonly noiseType?: "MONOTONE" | "DUOTONE" | "MULTITONE";
  readonly noiseSize?: number;
  readonly density?: number;
  readonly secondaryColor?: RGBA;
  readonly opacity?: number;
  readonly clipToShape?: boolean;
}

export interface TypeStyle {
  readonly fontFamily?: string;
  readonly fontPostScriptName?: string | null;
  readonly fontStyle?: string;
  readonly fontWeight?: number;
  readonly italic?: boolean;
  readonly fontSize?: number;
  readonly textCase?: string;
  readonly textDecoration?: string;
  readonly textAutoResize?: string;
  readonly textTruncation?: string;
  readonly maxLines?: number;
  readonly textAlignHorizontal?: string;
  readonly textAlignVertical?: string;
  readonly letterSpacing?: number;
  readonly lineHeightPx?: number;
  readonly lineHeightPercentFontSize?: number;
  readonly lineHeightUnit?: "PIXELS" | "FONT_SIZE_%" | "INTRINSIC_%";
  readonly paragraphSpacing?: number;
  /** Space between list items, in px. */
  readonly listSpacing?: number;
  readonly leadingTrim?: "CAP_HEIGHT" | "NONE";
  readonly opentypeFlags?: Readonly<Record<string, number>>;
  readonly fills?: readonly Paint[];
}

export interface LayoutGrid {
  readonly pattern: "COLUMNS" | "ROWS" | "GRID";
  readonly sectionSize?: number;
  readonly visible?: boolean;
  readonly color?: RGBA;
  readonly alignment?: "MIN" | "STRETCH" | "CENTER" | "MAX";
  readonly gutterSize?: number;
  readonly offset?: number;
  readonly count?: number;
}

/** A node of any type: what the converter reads, by node kind. */
export interface Node {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly children?: readonly Node[];
  readonly opacity?: number;
  readonly blendMode?: string;
  readonly isMask?: boolean;
  readonly maskType?: "ALPHA" | "VECTOR" | "LUMINANCE";
  /** Older files' word for a mask by outline (a VECTOR mask). */
  readonly isMaskOutline?: boolean;
  readonly relativeTransform?: Transform;
  readonly size?: Vector;
  readonly absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  readonly fills?: readonly Paint[];
  readonly strokes?: readonly Paint[];
  readonly strokeWeight?: number;
  readonly individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  readonly strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  readonly strokeJoin?: "MITER" | "BEVEL" | "ROUND";
  readonly strokeCap?: string;
  readonly strokeDashes?: readonly number[];
  readonly fillGeometry?: readonly { path: string; windingRule: "NONZERO" | "EVENODD" }[];
  readonly strokeGeometry?: readonly { path: string; windingRule: string }[];
  readonly cornerRadius?: number;
  readonly rectangleCornerRadii?: readonly [number, number, number, number];
  readonly effects?: readonly Effect[];
  readonly clipsContent?: boolean;
  readonly constraints?: { vertical: string; horizontal: string };
  readonly preserveRatio?: boolean;
  readonly layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  readonly layoutWrap?: "NO_WRAP" | "WRAP";
  readonly primaryAxisAlignItems?: string;
  readonly counterAxisAlignItems?: string;
  readonly primaryAxisSizingMode?: "FIXED" | "AUTO";
  readonly counterAxisSizingMode?: "FIXED" | "AUTO";
  readonly layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  readonly layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  readonly layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  readonly layoutGrow?: number;
  readonly layoutPositioning?: "AUTO" | "ABSOLUTE";
  readonly itemSpacing?: number;
  readonly counterAxisSpacing?: number;
  readonly paddingTop?: number;
  readonly paddingRight?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
  readonly minWidth?: number | null;
  readonly maxWidth?: number | null;
  readonly minHeight?: number | null;
  readonly maxHeight?: number | null;
  // Grid auto layout (`layoutMode: "GRID"`): tracks as CSS track lists ("32px 1fr auto"), gaps.
  readonly gridRowsSizing?: string;
  readonly gridColumnsSizing?: string;
  readonly gridRowGap?: number;
  readonly gridColumnGap?: number;
  // A grid's item: the row and column it starts at (from 0), its spans, and how it sits in its cells.
  readonly gridRowAnchorIndex?: number;
  readonly gridColumnAnchorIndex?: number;
  readonly gridRowSpan?: number;
  readonly gridColumnSpan?: number;
  readonly gridChildHorizontalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";
  readonly gridChildVerticalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";
  readonly layoutGrids?: readonly LayoutGrid[];
  readonly backgroundColor?: RGBA;
  // Text
  readonly characters?: string;
  readonly style?: TypeStyle;
  readonly characterStyleOverrides?: readonly number[];
  /** Per line (paragraph): its list, and its indentation (a list's first level is 1). */
  readonly lineTypes?: readonly ("NONE" | "ORDERED" | "UNORDERED")[];
  readonly lineIndentations?: readonly number[];
  readonly styleOverrideTable?: Readonly<Record<string, TypeStyle>>;
  // Components
  readonly componentId?: string;
  readonly componentPropertyDefinitions?: Readonly<Record<string, unknown>>;
  readonly overrides?: readonly { id: string; overriddenFields: readonly string[] }[];
  readonly booleanOperation?: string;
  readonly arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };
}

export interface File {
  readonly name: string;
  readonly document: Node;
  readonly components?: Readonly<
    Record<
      string,
      {
        key?: string;
        name?: string;
        componentSetId?: string;
        remote?: boolean;
        /** Its main is on a page the import left out (a .fig read in part), not in a library. */
        omitted?: boolean;
      }
    >
  >;
  readonly componentSets?: Readonly<Record<string, { name?: string }>>;
  readonly styles?: Readonly<Record<string, { name?: string; styleType?: string }>>;
  readonly version?: string;
  readonly lastModified?: string;
}
