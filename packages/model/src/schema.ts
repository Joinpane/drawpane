/**
 * Node types and their properties.
 *
 * Properties are flat and top-level (`gap`, `paddingTop`, `fills`), never
 * nested objects. A `set` operation replaces exactly one property, so two
 * people editing different properties of the same node never overwrite each
 * other. Every property has one schema and one default; a node stores only the
 * properties that differ from the default.
 */
import { z } from "zod";
import { ID_PATTERN } from "./ids";
import { DEVICE_IDS, Flows, Reactions } from "./prototype";

export const NODE_TYPES = [
  "page",
  "collection",
  "variable",
  "textStyle",
  "library",
  "frame",
  "group",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "line",
  "path",
  "text",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Node types that can sit on a page, inside a frame or inside a group. */
export const LAYER_TYPES = [
  "frame",
  "group",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "line",
  "path",
  "text",
] as const satisfies readonly NodeType[];
export type LayerType = (typeof LAYER_TYPES)[number];

/** Which child types each parent type accepts. The virtual root holds pages only. */
export const CHILD_TYPES: Readonly<Record<NodeType | "root", readonly NodeType[]>> = {
  root: ["page", "collection", "textStyle", "library"],
  page: LAYER_TYPES,
  collection: ["variable"],
  variable: [],
  textStyle: [],
  // A team library a file uses (decision 0010): read-only copies of its components and what they need.
  library: [...LAYER_TYPES, "textStyle", "collection"],
  frame: LAYER_TYPES,
  group: LAYER_TYPES,
  rect: [],
  ellipse: [],
  polygon: [],
  star: [],
  line: [],
  path: [],
  text: [],
};

// ---------------------------------------------------------------------------
// Value schemas

const finite = z.number().refine(Number.isFinite, "must be a finite number");

/** A number property's range, for the fields that edit it (propBounds). */
export interface Bounds {
  readonly min?: number;
  readonly max?: number;
}

/** Each ranged schema's bounds: fields clamp to them, so a drag or a typo stops at the edge. */
const BOUNDS = new WeakMap<z.ZodType, Bounds>();

/**
 * A number schema with a range that fields know about. The bounds can be
 * narrower than the schema where its edge is exclusive (a font size above 0
 * starts at 1 in a field).
 */
function ranged<S extends z.ZodType>(schema: S, bounds: Bounds): S {
  BOUNDS.set(schema, bounds);
  return schema;
}

const nonNegative = ranged(
  finite.refine((n) => n >= 0, "must be zero or more"),
  { min: 0 },
);
const unit = ranged(
  finite.refine((n) => n >= 0 && n <= 1, "must be between 0 and 1"),
  { min: 0, max: 1 },
);

/** `#rrggbb` or `#rrggbbaa`, lowercase. */
export const Color = z
  .string()
  .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/, "must be a lowercase hex color like #ff5a1f");
export type Color = z.infer<typeof Color>;

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export const BlendMode = z.enum(BLEND_MODES);
export type BlendMode = z.infer<typeof BlendMode>;

const Point = z.object({ x: finite, y: finite });

const paintBase = {
  visible: z.boolean().optional(),
  opacity: unit.optional(),
  blendMode: BlendMode.optional(),
};

export const SolidPaint = z.object({ type: z.literal("solid"), color: Color, ...paintBase });
export const GradientStop = z.object({ position: unit, color: Color });
export const GradientPaint = z.object({
  /**
   * Linear runs from `from` to `to`; radial spreads from `from` out to the
   * distance of `to`; angular sweeps clockwise around `from`, starting in the
   * direction of `to`.
   */
  type: z.enum(["linear", "radial", "angular"]),
  /** Start and end handles in the node's unit square (0,0 top-left to 1,1 bottom-right). */
  from: Point,
  to: Point,
  stops: z.array(GradientStop).min(2).max(32),
  ...paintBase,
});
/** The part of an image a cropped fill shows, in the image's unit square (0,0 top-left to 1,1). */
export const ImageCrop = z
  .object({
    x: unit,
    y: unit,
    width: finite.refine((n) => n > 0 && n <= 1, "must be more than 0 and at most 1"),
    height: finite.refine((n) => n > 0 && n <= 1, "must be more than 0 and at most 1"),
  })
  .refine((c) => c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001, {
    message: "The crop has to stay inside the image.",
  });
export type ImageCrop = z.infer<typeof ImageCrop>;

export const ImagePaint = z.object({
  type: z.literal("image"),
  /** Content hash of the image blob in R2. */
  ref: z.string().regex(/^[0-9a-f]{64}$/),
  /** "crop" shows `crop` (the whole image when missing) stretched to the box. */
  scaleMode: z.enum(["fill", "fit", "tile", "stretch", "crop"]),
  crop: ImageCrop.optional(),
  ...paintBase,
});
export const Paint = z.discriminatedUnion("type", [SolidPaint, GradientPaint, ImagePaint]);
export type Paint = z.infer<typeof Paint>;

export const Shadow = z.object({
  type: z.enum(["drop-shadow", "inner-shadow"]),
  color: Color,
  x: finite,
  y: finite,
  blur: nonNegative,
  spread: finite,
  visible: z.boolean().optional(),
});
export const Blur = z.object({
  type: z.enum(["layer-blur", "background-blur"]),
  radius: nonNegative,
  visible: z.boolean().optional(),
});
/** 0–100: how much of a glass property (refraction, dispersion, light…). */
const amount = ranged(
  finite.refine((n) => n >= 0 && n <= 100, "must be between 0 and 100"),
  { min: 0, max: 100 },
);
/**
 * Glass (decision 0007): what's behind the layer, seen through it as
 * through a lens with a curved rim. Light catches the rim from `angle`
 * (degrees: 0 is from the top, turning clockwise; −45 the top left) by `intensity`;
 * `refraction` bends the backdrop over a rim `depth` px wide; `dispersion`
 * splits its colours; `frost` blurs it (px); `splay` fans the bend outward.
 */
export const Glass = z.object({
  type: z.literal("glass"),
  angle: finite,
  intensity: amount,
  refraction: amount,
  // Figma's range is 0–100 (and the slider's); files from before still load, drawn at 100.
  depth: ranged(
    finite.refine((n) => n >= 0 && n <= 200, "must be between 0 and 200"),
    { min: 0, max: 100 },
  ),
  dispersion: amount,
  frost: ranged(
    finite.refine((n) => n >= 0 && n <= 100, "must be between 0 and 100"),
    { min: 0, max: 100 },
  ),
  splay: amount,
  visible: z.boolean().optional(),
});
export type Glass = z.infer<typeof Glass>;

/** Figma's defaults for a new glass effect. */
export const DEFAULT_GLASS: Glass = {
  type: "glass",
  angle: -45,
  intensity: 80,
  refraction: 80,
  depth: 20,
  dispersion: 50,
  frost: 4,
  splay: 0,
};

/** The range of a glass property, for fields and sliders. */
export function glassBounds(key: Exclude<keyof Glass, "type" | "visible" | "angle">): Bounds {
  return effectBounds("glass", key);
}

/** A grain's size in px: noise and texture cells. */
const grain = ranged(
  finite.refine((n) => n >= 0.5 && n <= 50, "must be between 0.5 and 50"),
  { min: 0.5, max: 50 },
);

/**
 * Noise (decision 0008): grain over the layer, only where it paints. Each
 * cell `size` px square is "on" with a `density`% chance. Mono paints on
 * cells in `color`; duo paints on cells in `color` and the rest in
 * `secondaryColor`; multi paints on cells in random colours at `opacity`%.
 * All the values are kept whichever kind it is, so switching back loses nothing.
 */
export const Noise = z.object({
  type: z.literal("noise"),
  noiseType: z.enum(["mono", "duo", "multi"]),
  size: grain,
  density: amount,
  color: Color,
  secondaryColor: Color,
  opacity: amount,
  visible: z.boolean().optional(),
});
export type Noise = z.infer<typeof Noise>;
export type NoiseType = Noise["noiseType"];

/** A new noise: fine dark grain over half the layer. */
export const DEFAULT_NOISE: Noise = {
  type: "noise",
  noiseType: "mono",
  size: 1,
  density: 50,
  color: "#00000040",
  secondaryColor: "#ffffff40",
  opacity: 25,
};

/**
 * Texture (decision 0008): the layer's edges roughened, as if printed on
 * rough paper. Each cell `size` px square moves its pixels by up to
 * `radius` px; with `clipToShape` nothing reaches past the layer's edge.
 */
export const Texture = z.object({
  type: z.literal("texture"),
  size: grain,
  radius: ranged(
    finite.refine((n) => n >= 0 && n <= 100, "must be between 0 and 100"),
    { min: 0, max: 100 },
  ),
  clipToShape: z.boolean(),
  visible: z.boolean().optional(),
});
export type Texture = z.infer<typeof Texture>;

/** A new texture: a fine, sandy edge. */
export const DEFAULT_TEXTURE: Texture = {
  type: "texture",
  size: 2,
  radius: 4,
  clipToShape: false,
};

const EFFECT_SHAPES = { glass: Glass.shape, noise: Noise.shape, texture: Texture.shape };
type RangedEffect = keyof typeof EFFECT_SHAPES;

/** The range of an effect's number, for fields and sliders: `effectBounds("noise", "density")`. */
export function effectBounds<T extends RangedEffect>(
  type: T,
  key: keyof (typeof EFFECT_SHAPES)[T],
): Bounds {
  const schema = EFFECT_SHAPES[type][key] as z.ZodType;
  return BOUNDS.get(schema) ?? {};
}

export const Effect = z.discriminatedUnion("type", [Shadow, Blur, Glass, Noise, Texture]);
export type Effect = z.infer<typeof Effect>;

/** A ruler guide: a line across its page, or across its frame, at an offset on one axis. */
export const RulerGuide = z.object({
  /** "x": a vertical line at x = offset. "y": a horizontal line at y = offset. */
  axis: z.enum(["x", "y"]),
  /** In the owner's coordinates: page coordinates for a page, frame-local for a frame. */
  offset: finite,
});
export type RulerGuide = z.infer<typeof RulerGuide>;

const trackGrid = {
  count: z
    .number()
    .int()
    .refine((n) => n >= 1 && n <= 100, "must be between 1 and 100"),
  gutter: nonNegative,
  margin: nonNegative,
  /** Stretch fills the frame between the margins; the others use `size` per track. */
  alignment: z.enum(["stretch", "start", "center", "end"]),
  /** Track width (columns) or height (rows) when not stretched. */
  size: nonNegative,
  color: Color,
  visible: z.boolean().optional(),
};

/** A frame's layout grid: columns, rows, or a square grid, drawn while you design. */
export const LayoutGrid = z.discriminatedUnion("type", [
  z.object({ type: z.literal("columns"), ...trackGrid }),
  z.object({ type: z.literal("rows"), ...trackGrid }),
  z.object({
    type: z.literal("grid"),
    size: finite.refine((n) => n >= 1 && n <= 10_000, "must be between 1 and 10000"),
    color: Color,
    visible: z.boolean().optional(),
  }),
]);
export type LayoutGrid = z.infer<typeof LayoutGrid>;

/**
 * One track of a grid layout, as in CSS `grid-template-columns`: a fixed size
 * in pixels, a share of the free space (`fr`), or `auto` (as big as its
 * largest item).
 */
export const GridTrack = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("px"), value: nonNegative }),
  z.object({
    unit: z.literal("fr"),
    value: finite.refine((n) => n > 0 && n <= 1000, "must be between 0 and 1000"),
  }),
  z.object({ unit: z.literal("auto") }),
]);
export type GridTrack = z.infer<typeof GridTrack>;

const gridLine = z
  .number()
  .int()
  .refine((n) => n >= 1 && n <= 256, "must be between 1 and 256");

/**
 * Where a layer sits in its parent's grid, as in CSS `grid-area`: the column
 * and row it starts at (from 1) and how many it spans. Null places it
 * automatically, in the next free cell.
 */
export const GridArea = z.object({
  column: gridLine,
  row: gridLine,
  columnSpan: gridLine,
  rowSpan: gridLine,
});
export type GridArea = z.infer<typeof GridArea>;

export const LineHeight = z.union([
  z.object({ unit: z.literal("auto") }),
  z.object({ unit: z.literal("px"), value: nonNegative }),
  z.object({ unit: z.literal("percent"), value: nonNegative }),
]);
export type LineHeight = z.infer<typeof LineHeight>;

export const LetterSpacing = z.object({ unit: z.enum(["px", "percent"]), value: finite });
export type LetterSpacing = z.infer<typeof LetterSpacing>;

const FontSize = ranged(
  finite.refine((n) => n > 0 && n <= 4096, "must be between 0 and 4096"),
  // Above 0, so a field starts at 1, like Figma.
  { min: 1, max: 4096 },
);

/**
 * OpenType features a run turns on or off, by tag: `{ tnum: true, liga: false,
 * ss01: true }` (docs/decisions/0005-opentype-features.md). A tag left out is the
 * font's default; an empty map draws the font as it comes.
 */
export const FontFeatures = z
  .record(z.string().regex(/^[A-Za-z0-9]{4}$/, "must be a four-letter OpenType tag"), z.boolean())
  .refine((m) => Object.keys(m).length <= 64, "at most 64 features");
export type FontFeatures = z.infer<typeof FontFeatures>;

/**
 * A variable font's axes a run sets, by tag (docs/decisions/0009-variable-fonts.md):
 * `{ wdth: 85, GRAD: 50 }`. Weight is `fontWeight` and italic `fontStyle`, so
 * `wght` and `ital` aren't here. An axis left out is at the font's default,
 * except optical size, which follows the font size; values are clamped to
 * what the font covers when drawn.
 */
export const FontVariations = z
  .record(z.string().regex(/^[A-Za-z0-9]{4}$/, "must be a four-letter axis tag"), finite)
  .refine((m) => !("wght" in m) && !("ital" in m), {
    message: "weight and italic are fontWeight and fontStyle, not axes here",
  })
  .refine((m) => Object.keys(m).length <= 32, "at most 32 axes");
export type FontVariations = z.infer<typeof FontVariations>;

/**
 * Styling on part of a text layer's characters: [start, end) in UTF-16 code
 * units of `characters`, overriding some of the layer's own typography and
 * fill. A layer's runs are sorted and don't overlap; characters outside every
 * run use the layer's props. The editor keeps runs in step as text changes.
 */
/**
 * A paragraph's list (decision 0017): none, bulleted or numbered, and how
 * deeply nested. They're set on characters like the rest of a run's style,
 * so editing keeps them (a new line in a list continues it); a paragraph
 * takes the list of its first character.
 */
export const ListType = z.enum(["none", "bullet", "number"]);
export type ListType = z.infer<typeof ListType>;
export const ListLevel = z.number().int().min(0).max(8);

export const TextRun = z
  .object({
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    fontFamily: z.string().min(1).max(128).optional(),
    fontWeight: z.number().int().min(1).max(1000).optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    fontSize: FontSize.optional(),
    letterSpacing: LetterSpacing.optional(),
    lineHeight: LineHeight.optional(),
    textCase: z.enum(["none", "upper", "lower", "title"]).optional(),
    textDecoration: z.enum(["none", "underline", "strikethrough"]).optional(),
    fontFeatures: FontFeatures.optional(),
    fontVariations: FontVariations.optional(),
    fills: z.array(Paint).max(8).optional(),
    listType: ListType.optional(),
    listLevel: ListLevel.optional(),
  })
  .refine((run) => run.end > run.start, "a run must end after it starts");
export type TextRun = z.infer<typeof TextRun>;

/** Only the characters an SVG path `d` attribute can contain. Parsed and checked by the editor. */
const PathData = z
  .string()
  .max(2_000_000)
  .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/, "must be SVG path data");

export const Mode = z.object({ id: z.string().regex(ID_PATTERN), name: z.string().min(1).max(64) });
export type Mode = z.infer<typeof Mode>;
/** A variable's value in one mode: a literal, or an alias to another variable (DTCG `{group.token}`). */
export const VariableValue = z.union([
  Color,
  finite,
  z.string().max(10_000),
  z.object({ alias: z.string().regex(ID_PATTERN) }),
]);
export type VariableValue = z.infer<typeof VariableValue>;

/**
 * Properties a variable can drive. `fill` and `stroke` drive the colour of the
 * first solid paint; the rest are the property of the same name.
 */
export const BINDING_KEYS = [
  "fill",
  "stroke",
  "width",
  "height",
  "gap",
  "rowGap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "cornerRadius",
  "strokeWeight",
  "opacity",
  "fontSize",
  "fontFamily",
  "characters",
] as const;
export type BindingKey = (typeof BINDING_KEYS)[number];

// ---------------------------------------------------------------------------
// Property registry

interface PropSpec<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly default: z.infer<S>;
  readonly types: readonly NodeType[];
}

function prop<S extends z.ZodType>(
  schema: S,
  defaultValue: z.infer<S>,
  types: readonly NodeType[],
): PropSpec<S> {
  return { schema, default: defaultValue, types };
}

const ALL = NODE_TYPES;
const LAYERS = LAYER_TYPES;
/** Types with their own geometry. Groups derive theirs from their children. */
const GEOMETRY = ["frame", "rect", "ellipse", "polygon", "star", "line", "path", "text"] as const;
const SHAPES = ["frame", "rect", "ellipse", "polygon", "star", "line", "path", "text"] as const;
/** Shapes whose corners round with one radius. */
const ROUNDED = ["frame", "rect", "polygon", "star"] as const;
/** Shapes with four corners that can each have their own radius. */
const CORNERS = ["frame", "rect"] as const;
/** Shapes with open ends: line caps and end markers apply. */
const OPEN_ENDS = ["line", "path"] as const;

/** Layers that can be a mask: anything with a filled outline. */
const MASKABLE = ["frame", "rect", "ellipse", "polygon", "star", "path"] as const;

/** What an open stroke's end looks like (Figma's arrow and marker ends). */
export const STROKE_MARKERS = ["none", "arrow", "triangle", "circle", "diamond", "bar"] as const;
export type StrokeMarker = (typeof STROKE_MARKERS)[number];
const CONTAINERS = ["frame"] as const;
/** Text layers, and the text styles that set their typography. */
const TYPOGRAPHY = ["text", "textStyle"] as const;

export const PROPS = {
  name: prop(z.string().max(256), "", ALL),
  visible: prop(z.boolean(), true, LAYERS),
  locked: prop(z.boolean(), false, LAYERS),
  opacity: prop(unit, 1, LAYERS),
  blendMode: prop(BlendMode, "normal", LAYERS),

  // Geometry: the unrotated box in the coordinate space of the nearest frame
  // or page. Rotation turns the box about its centre.
  x: prop(finite, 0, GEOMETRY),
  y: prop(finite, 0, GEOMETRY),
  width: prop(nonNegative, 0, GEOMETRY),
  height: prop(nonNegative, 0, GEOMETRY),
  rotation: prop(finite, 0, GEOMETRY),
  flipX: prop(z.boolean(), false, GEOMETRY),
  flipY: prop(z.boolean(), false, GEOMETRY),
  /** Keep width and height in proportion when either changes (the inspector's lock, handles). */
  lockAspect: prop(z.boolean(), false, GEOMETRY),

  fills: prop(z.array(Paint).max(32), [], SHAPES),
  strokes: prop(z.array(Paint).max(32), [], SHAPES),
  strokeWeight: prop(nonNegative, 1, SHAPES),
  strokeAlign: prop(z.enum(["inside", "center", "outside"]), "inside", SHAPES),
  strokeCap: prop(z.enum(["none", "round", "square"]), "none", OPEN_ENDS),
  /** Markers at the start and end of a line or open path: arrows, dots, bars. */
  markerStart: prop(z.enum(STROKE_MARKERS), "none", OPEN_ENDS),
  markerEnd: prop(z.enum(STROKE_MARKERS), "none", OPEN_ENDS),
  strokeJoin: prop(z.enum(["miter", "round", "bevel"]), "miter", SHAPES),
  strokeDashes: prop(z.array(nonNegative).max(16), [], SHAPES),
  /**
   * Per-side stroke widths (top, right, bottom, left), like Figma's
   * individual stroke weights: a row's bottom border, a sidebar's divider.
   * Overrides `strokeWeight`, which the inspector keeps at the widest side.
   */
  strokeWeights: prop(
    z.tuple([nonNegative, nonNegative, nonNegative, nonNegative]).nullable(),
    null,
    CORNERS,
  ),
  effects: prop(z.array(Effect).max(32), [], LAYERS),
  /**
   * A mask: its outline clips the layers above it in the same parent (up to
   * the next mask), and it isn't drawn itself, like Figma's "Use as mask".
   */
  isMask: prop(z.boolean(), false, MASKABLE),
  /**
   * How a mask masks, as in Figma: by its outline (a hard clip), by its
   * alpha (fills, gradients, opacity and blur fade what's above), or by its
   * luminance (light shows, dark hides).
   */
  maskType: prop(z.enum(["outline", "alpha", "luminance"]), "outline", MASKABLE),

  cornerRadius: prop(nonNegative, 0, ROUNDED),

  // Polygons and stars: points around an ellipse that fills the box.
  pointCount: prop(
    ranged(
      z
        .number()
        .int()
        .refine((n) => n >= 3 && n <= 60, "must be between 3 and 60"),
      { min: 3, max: 60 },
    ),
    3,
    ["polygon", "star"],
  ),
  /** A star's inner points as a fraction of its outer radius. */
  innerRadius: prop(
    ranged(
      finite.refine((n) => n > 0 && n <= 1, "must be more than 0 and at most 1"),
      { min: 0.01, max: 1 },
    ),
    0.382,
    ["star"],
  ),
  /** Per-corner radii (top-left, top-right, bottom-right, bottom-left); overrides cornerRadius. */
  cornerRadii: prop(
    z.tuple([nonNegative, nonNegative, nonNegative, nonNegative]).nullable(),
    null,
    CORNERS,
  ),

  // Components. A main component is a frame with `isComponent`. An instance
  // is a frame with `instanceOf` (the main component's id); each layer inside
  // it `mirrors` the main component's layer it copies, and lists the
  // properties you changed in `overrides`, which syncing then leaves alone.
  isComponent: prop(z.boolean(), false, CONTAINERS),
  /** A frame that groups variants: main components that differ by `variantProps`. */
  isComponentSet: prop(z.boolean(), false, CONTAINERS),
  /** A variant's property values, e.g. { State: "Hover", Size: "Large" }. */
  variantProps: prop(z.record(z.string().min(1).max(64), z.string().max(64)), {}, CONTAINERS),
  componentDescription: prop(z.string().max(2000), "", CONTAINERS),
  instanceOf: prop(z.string().regex(ID_PATTERN).nullable(), null, CONTAINERS),
  mirrors: prop(z.string().regex(ID_PATTERN).nullable(), null, LAYERS),
  overrides: prop(z.array(z.string().max(64)).max(64), [], LAYERS),

  // Frames
  clipContent: prop(z.boolean(), true, CONTAINERS),
  layoutMode: prop(z.enum(["none", "row", "column", "grid"]), "none", CONTAINERS),
  layoutWrap: prop(z.boolean(), false, CONTAINERS),
  gap: prop(finite, 0, CONTAINERS),
  rowGap: prop(finite, 0, CONTAINERS),
  paddingTop: prop(nonNegative, 0, CONTAINERS),
  paddingRight: prop(nonNegative, 0, CONTAINERS),
  paddingBottom: prop(nonNegative, 0, CONTAINERS),
  paddingLeft: prop(nonNegative, 0, CONTAINERS),
  justifyContent: prop(z.enum(["start", "center", "end", "space-between"]), "start", CONTAINERS),
  alignItems: prop(z.enum(["start", "center", "end", "stretch", "baseline"]), "start", CONTAINERS),
  // Grid layout: tracks, and how items sit across their cells (`alignItems` sits them down).
  gridColumns: prop(z.array(GridTrack).max(64), [], CONTAINERS),
  gridRows: prop(z.array(GridTrack).max(64), [], CONTAINERS),
  justifyItems: prop(z.enum(["start", "center", "end", "stretch"]), "start", CONTAINERS),

  // How a layer sits in its parent's layout
  sizingH: prop(z.enum(["fixed", "hug", "fill"]), "fixed", GEOMETRY),
  sizingV: prop(z.enum(["fixed", "hug", "fill"]), "fixed", GEOMETRY),
  minWidth: prop(nonNegative.nullable(), null, GEOMETRY),
  maxWidth: prop(nonNegative.nullable(), null, GEOMETRY),
  minHeight: prop(nonNegative.nullable(), null, GEOMETRY),
  maxHeight: prop(nonNegative.nullable(), null, GEOMETRY),
  positioning: prop(z.enum(["auto", "absolute"]), "auto", LAYERS),
  /** Overrides the parent's `alignItems` for this layer (flex cross axis, or down a grid cell). */
  alignSelf: prop(z.enum(["auto", "start", "center", "end", "stretch"]), "auto", LAYERS),
  /** Overrides the parent grid's `justifyItems` for this layer. */
  justifySelf: prop(z.enum(["auto", "start", "center", "end", "stretch"]), "auto", LAYERS),
  gridArea: prop(GridArea.nullable(), null, LAYERS),
  constraintH: prop(z.enum(["start", "end", "center", "stretch", "scale"]), "start", LAYERS),
  constraintV: prop(z.enum(["start", "end", "center", "stretch", "scale"]), "start", LAYERS),

  // Text
  characters: prop(z.string().max(200_000), "", ["text"]),
  fontFamily: prop(z.string().min(1).max(128), "Instrument Sans", TYPOGRAPHY),
  fontWeight: prop(z.number().int().min(1).max(1000), 400, TYPOGRAPHY),
  fontStyle: prop(z.enum(["normal", "italic"]), "normal", TYPOGRAPHY),
  fontSize: prop(FontSize, 16, TYPOGRAPHY),
  lineHeight: prop(LineHeight, { unit: "auto" }, TYPOGRAPHY),
  letterSpacing: prop(LetterSpacing, { unit: "px", value: 0 }, TYPOGRAPHY),
  textAlign: prop(z.enum(["left", "center", "right", "justify"]), "left", ["text"]),
  textAlignVertical: prop(z.enum(["top", "middle", "bottom"]), "top", ["text"]),
  textAutoResize: prop(z.enum(["none", "width", "height"]), "width", ["text"]),
  textCase: prop(z.enum(["none", "upper", "lower", "title"]), "none", TYPOGRAPHY),
  textDecoration: prop(z.enum(["none", "underline", "strikethrough"]), "none", TYPOGRAPHY),
  /** OpenType features (tabular figures, ligatures, stylistic sets…); see `FontFeatures`. */
  fontFeatures: prop(FontFeatures, {}, TYPOGRAPHY),
  fontVariations: prop(FontVariations, {}, TYPOGRAPHY),
  /**
   * Figma's vertical trim: "cap-height" fits the text's box from its first
   * line's cap height to its last line's baseline, dropping the space above
   * capitals and below the baseline, so the box aligns with what's seen.
   */
  leadingTrim: prop(z.enum(["none", "cap-height"]), "none", TYPOGRAPHY),
  /** Extra space after each paragraph (each hard line break), in px. */
  paragraphSpacing: prop(ranged(z.number().min(0).max(1000), { min: 0, max: 1000 }), 0, TYPOGRAPHY),
  /** Lists: the layer's own (its characters may differ, paragraph by paragraph; see `ListType`). */
  listType: prop(ListType, "none", ["text"]),
  listLevel: prop(ListLevel, 0, ["text"]),
  /** Show at most this many lines, the last ending in "…"; null shows them all. */
  maxLines: prop(z.number().int().min(1).max(1000).nullable(), null, ["text"]),
  /** Styled ranges of the characters (bold words, a coloured phrase); see `TextRun`. */
  textRuns: prop(z.array(TextRun).max(10_000), [], ["text"]),
  /** The text style this layer follows; its typography comes from the style while it does. */
  textStyle: prop(z.string().regex(ID_PATTERN).nullable(), null, ["text"]),

  // Vectors
  pathData: prop(PathData, "", ["path"]),
  windingRule: prop(z.enum(["nonzero", "evenodd"]), "nonzero", ["path"]),

  // Guides and grids: aids while designing, never drawn in exports.
  rulerGuides: prop(z.array(RulerGuide).max(200), [], ["page", "frame"]),
  layoutGrids: prop(z.array(LayoutGrid).max(16), [], CONTAINERS),
  /**
   * The order a screen reader (and keyboard focus) moves through a board, as
   * layer ids. Null until someone sets it: the order then comes from the
   * layout (see the editor's reading-order.ts).
   */
  readingOrder: prop(z.array(z.string().regex(ID_PATTERN)).max(500).nullable(), null, CONTAINERS),

  // Pages. Null follows the viewer's theme (the `canvas` token).
  backgroundColor: prop(Color.nullable(), null, ["page"]),

  // Prototyping. Reactions say what a layer does when tapped, hovered, dragged
  // or keyed; flows are the starting screens a page offers; the device frames
  // the prototype when it plays.
  reactions: prop(Reactions, [], LAYERS),
  flows: prop(Flows, [], ["page"]),
  prototypeDevice: prop(z.enum(DEVICE_IDS), "none", ["page"]),

  // Variables (design tokens). A collection holds variables and names the
  // modes (light, dark, compact…); each variable has one value per mode.
  modes: prop(z.array(Mode).min(1).max(16), [{ id: "m1", name: "Default" }], ["collection"]),
  variableType: prop(z.enum(["color", "number", "string"]), "color", ["variable"]),
  values: prop(z.record(z.string().regex(ID_PATTERN), VariableValue), {}, ["variable"]),
  description: prop(z.string().max(2000), "", ["variable", "collection", "textStyle"]),
  // A library this file uses (decision 0010): the library's file, and the publish its copies are from.
  libraryFile: prop(z.string().regex(ID_PATTERN).nullable(), null, ["library"]),
  libraryPublish: prop(z.string().regex(ID_PATTERN).nullable(), null, ["library"]),
  /** Bound properties: binding key → variable id. The bound property holds the resolved value. */
  bindings: prop(z.partialRecord(z.enum(BINDING_KEYS), z.string().regex(ID_PATTERN)), {}, LAYERS),
  /** Which mode of each collection applies inside this frame or page: collection id → mode id. */
  variableModes: prop(z.record(z.string().regex(ID_PATTERN), z.string().regex(ID_PATTERN)), {}, [
    "page",
    "frame",
  ]),
} as const satisfies Record<string, PropSpec>;

export type PropName = keyof typeof PROPS;
export type PropValues = { -readonly [K in PropName]: z.infer<(typeof PROPS)[K]["schema"]> };
/** What a node stores: only the properties that differ from their defaults. */
export type Props = Partial<PropValues>;

export const PROP_NAMES = Object.keys(PROPS) as PropName[];

const allowedProps: Record<NodeType, ReadonlySet<PropName>> = Object.fromEntries(
  NODE_TYPES.map((type) => [
    type,
    new Set(PROP_NAMES.filter((name) => (PROPS[name].types as readonly NodeType[]).includes(type))),
  ]),
) as unknown as Record<NodeType, ReadonlySet<PropName>>;

export function isPropName(name: string): name is PropName {
  return Object.hasOwn(PROPS, name);
}

export function propAllowed(type: NodeType, name: PropName): boolean {
  return allowedProps[type].has(name);
}

export function propsFor(type: NodeType): ReadonlySet<PropName> {
  return allowedProps[type];
}

export function defaultOf<K extends PropName>(name: K): PropValues[K] {
  return PROPS[name].default as PropValues[K];
}

/** A property's value on a node, falling back to the default. */
/**
 * The range a number property takes ({} when it's any number): what fields
 * clamp typing and scrubbing to, so a fast drag lands exactly on the edge
 * instead of being refused just short of it.
 */
export function propBounds(name: PropName): Bounds {
  let schema: z.ZodType = PROPS[name].schema;
  // Through .optional() and .nullable() to the number inside.
  // (Only those: an array's unwrap is its items, which aren't the property's range.)
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    schema = schema.unwrap() as z.ZodType;
  return BOUNDS.get(schema) ?? {};
}

export function getProp<K extends PropName>(props: Props, name: K): PropValues[K] {
  const value = props[name];
  return (value === undefined ? PROPS[name].default : value) as PropValues[K];
}

export function isNodeType(type: string): type is NodeType {
  return (NODE_TYPES as readonly string[]).includes(type);
}
