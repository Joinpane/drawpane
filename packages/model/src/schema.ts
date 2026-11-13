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

export const NODE_TYPES = [
  "page",
  "frame",
  "group",
  "rect",
  "ellipse",
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
  "line",
  "path",
  "text",
] as const satisfies readonly NodeType[];
export type LayerType = (typeof LAYER_TYPES)[number];

/** Which child types each parent type accepts. The virtual root holds pages only. */
export const CHILD_TYPES: Readonly<Record<NodeType | "root", readonly NodeType[]>> = {
  root: ["page"],
  page: LAYER_TYPES,
  frame: LAYER_TYPES,
  group: LAYER_TYPES,
  rect: [],
  ellipse: [],
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
  type: z.enum(["linear", "radial"]),
  /** Start and end handles in the node's unit square (0,0 top-left to 1,1 bottom-right). */
  from: Point,
  to: Point,
  stops: z.array(GradientStop).min(2).max(32),
  ...paintBase,
});
export const ImagePaint = z.object({
  type: z.literal("image"),
  /** Content hash of the image blob in R2. */
  ref: z.string().regex(/^[0-9a-f]{64}$/),
  scaleMode: z.enum(["fill", "fit", "tile", "stretch"]),
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
const GEOMETRY = ["frame", "rect", "ellipse", "line", "path", "text"] as const;
const SHAPES = ["frame", "rect", "ellipse", "line", "path", "text"] as const;
const CORNERS = ["frame", "rect"] as const;
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

  fills: prop(z.array(Paint).max(32), [], SHAPES),
  strokes: prop(z.array(Paint).max(32), [], SHAPES),
  strokeWeight: prop(nonNegative, 1, SHAPES),
  strokeAlign: prop(z.enum(["inside", "center", "outside"]), "inside", SHAPES),
  strokeCap: prop(z.enum(["none", "round", "square"]), "none", ["line", "path"]),
  strokeJoin: prop(z.enum(["miter", "round", "bevel"]), "miter", SHAPES),
  strokeDashes: prop(z.array(nonNegative).max(16), [], SHAPES),
  effects: prop(z.array(Effect).max(32), [], LAYERS),

  cornerRadius: prop(nonNegative, 0, CORNERS),
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

  // Pages. Null follows the viewer's theme (the `canvas` token).
  backgroundColor: prop(Color.nullable(), null, ["page"]),
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
