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
  root: ["page", "collection"],
  page: LAYER_TYPES,
  collection: ["variable"],
  variable: [],
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
const nonNegative = finite.refine((n) => n >= 0, "must be zero or more");
const unit = finite.refine((n) => n >= 0 && n <= 1, "must be between 0 and 1");

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
export const Effect = z.discriminatedUnion("type", [Shadow, Blur]);
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

export const LineHeight = z.union([
  z.object({ unit: z.literal("auto") }),
  z.object({ unit: z.literal("px"), value: nonNegative }),
  z.object({ unit: z.literal("percent"), value: nonNegative }),
]);
export type LineHeight = z.infer<typeof LineHeight>;

export const LetterSpacing = z.object({ unit: z.enum(["px", "percent"]), value: finite });
export type LetterSpacing = z.infer<typeof LetterSpacing>;

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
  effects: prop(z.array(Effect).max(32), [], LAYERS),
  /**
   * A mask: its outline clips the layers above it in the same parent (up to
   * the next mask), and it isn't drawn itself, like Figma's "Use as mask".
   */
  isMask: prop(z.boolean(), false, MASKABLE),

  cornerRadius: prop(nonNegative, 0, ROUNDED),

  // Polygons and stars: points around an ellipse that fills the box.
  pointCount: prop(
    z
      .number()
      .int()
      .refine((n) => n >= 3 && n <= 60, "must be between 3 and 60"),
    3,
    ["polygon", "star"],
  ),
  /** A star's inner points as a fraction of its outer radius. */
  innerRadius: prop(
    finite.refine((n) => n > 0 && n <= 1, "must be more than 0 and at most 1"),
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
  layoutMode: prop(z.enum(["none", "row", "column"]), "none", CONTAINERS),
  layoutWrap: prop(z.boolean(), false, CONTAINERS),
  gap: prop(finite, 0, CONTAINERS),
  rowGap: prop(finite, 0, CONTAINERS),
  paddingTop: prop(nonNegative, 0, CONTAINERS),
  paddingRight: prop(nonNegative, 0, CONTAINERS),
  paddingBottom: prop(nonNegative, 0, CONTAINERS),
  paddingLeft: prop(nonNegative, 0, CONTAINERS),
  justifyContent: prop(z.enum(["start", "center", "end", "space-between"]), "start", CONTAINERS),
  alignItems: prop(z.enum(["start", "center", "end", "stretch", "baseline"]), "start", CONTAINERS),

  // How a layer sits in its parent's layout
  sizingH: prop(z.enum(["fixed", "hug", "fill"]), "fixed", GEOMETRY),
  sizingV: prop(z.enum(["fixed", "hug", "fill"]), "fixed", GEOMETRY),
  minWidth: prop(nonNegative.nullable(), null, GEOMETRY),
  maxWidth: prop(nonNegative.nullable(), null, GEOMETRY),
  minHeight: prop(nonNegative.nullable(), null, GEOMETRY),
  maxHeight: prop(nonNegative.nullable(), null, GEOMETRY),
  positioning: prop(z.enum(["auto", "absolute"]), "auto", LAYERS),
  constraintH: prop(z.enum(["start", "end", "center", "stretch", "scale"]), "start", LAYERS),
  constraintV: prop(z.enum(["start", "end", "center", "stretch", "scale"]), "start", LAYERS),

  // Text
  characters: prop(z.string().max(200_000), "", ["text"]),
  fontFamily: prop(z.string().min(1).max(128), "Instrument Sans", ["text"]),
  fontWeight: prop(z.number().int().min(1).max(1000), 400, ["text"]),
  fontStyle: prop(z.enum(["normal", "italic"]), "normal", ["text"]),
  fontSize: prop(
    finite.refine((n) => n > 0 && n <= 4096, "must be between 0 and 4096"),
    16,
    ["text"],
  ),
  lineHeight: prop(LineHeight, { unit: "auto" }, ["text"]),
  letterSpacing: prop(LetterSpacing, { unit: "px", value: 0 }, ["text"]),
  textAlign: prop(z.enum(["left", "center", "right", "justify"]), "left", ["text"]),
  textAlignVertical: prop(z.enum(["top", "middle", "bottom"]), "top", ["text"]),
  textAutoResize: prop(z.enum(["none", "width", "height"]), "width", ["text"]),
  textCase: prop(z.enum(["none", "upper", "lower", "title"]), "none", ["text"]),
  textDecoration: prop(z.enum(["none", "underline", "strikethrough"]), "none", ["text"]),

  // Vectors
  pathData: prop(PathData, "", ["path"]),
  windingRule: prop(z.enum(["nonzero", "evenodd"]), "nonzero", ["path"]),

  // Guides and grids: aids while designing, never drawn in exports.
  rulerGuides: prop(z.array(RulerGuide).max(200), [], ["page", "frame"]),
  layoutGrids: prop(z.array(LayoutGrid).max(16), [], CONTAINERS),

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
  description: prop(z.string().max(2000), "", ["variable", "collection"]),
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
export function getProp<K extends PropName>(props: Props, name: K): PropValues[K] {
  const value = props[name];
  return (value === undefined ? PROPS[name].default : value) as PropValues[K];
}

export function isNodeType(type: string): type is NodeType {
  return (NODE_TYPES as readonly string[]).includes(type);
}
