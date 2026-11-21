/**
 * Agent tools (decision 0021): defined once, with a schema and a level, and
 * run against an `Editor`, whichever engine holds it (an editor open in a
 * browser, or a headless one in the Worker). MCP and the built-in agent list
 * them from here.
 *
 * A write tool runs as one transaction: everything it does is one undo step,
 * labelled with its name; if it fails, everything it did is reverted and
 * nothing is left behind. Tools never run code an agent wrote.
 */
import {
  BINDING_KEYS,
  type BindingKey,
  getProp,
  keysBetween,
  type LayerType,
  type Op,
  type PropName,
  type Props,
} from "@drawpane/model";
import { z } from "zod";
import type { Editor } from "../editor";
import { ExportError } from "../export";
import { base64, type HeadlessPng, type PngOptions } from "../headless-render";
import {
  expandOne,
  JSX_TAGS,
  JsxError,
  JsxTooLong,
  type JsxTree,
  jsxToTrees,
  nodeToJsx,
  TAG_OF,
} from "./jsx";

/** read: looks only; view: changes what's shown, not the file; write: changes the file. */
export type ToolLevel = "read" | "view" | "write";

export interface ToolResult {
  /** What the tool answers, as JSON. */
  readonly data: unknown;
  /** An image to show the model (a render). */
  readonly image?: { readonly mimeType: string; readonly base64: string };
}

/**
 * What a tool needs from its engine besides the editor. Rendering is the
 * engine's own: the open editor draws with its canvas, the headless one
 * with the headless CPU engine (decision 0040).
 */
export interface ToolServices {
  /** Draws a layer, or every layer on a page, as a PNG. */
  readonly renderPng?: (
    nodeId: string,
    options: PngOptions,
    locale?: string,
  ) => Promise<HeadlessPng>;
}

export interface AgentTool<I extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly level: ToolLevel;
  readonly input: I;
  run(editor: Editor, input: z.infer<I>, services: ToolServices): ToolResult | Promise<ToolResult>;
}

/** A tool's own failure, worded for the model: what was wrong and how to put it right. */
export class ToolFailure extends Error {
  override readonly name = "ToolFailure";
}

const defineTool = <I extends z.ZodType>(tool: AgentTool<I>): AgentTool<I> => tool;

const id = z.string().min(1).max(64);

/** A layer by id, or a failure that says the id is unknown. */
function need(editor: Editor, nodeId: string) {
  const node = editor.doc.get(nodeId);
  if (!node) throw new ToolFailure(`There's no layer ${nodeId}. Read the outline for current ids.`);
  return node;
}

/**
 * Properties as an agent writes them in `set_props`: model properties by
 * name, or the JSX short forms (w, h, fill, p…), checked against the model.
 */
function checkedProps(editor: Editor, nodeId: string, raw: Record<string, unknown>): Props {
  const node = need(editor, nodeId);
  const tag = TAG_OF[node.type as LayerType];
  if (!tag) throw new ToolFailure(`${nodeId} is a ${node.type}: set_props changes layers`);
  // The JSX reader knows the short forms and checks every value against the model.
  const attrs = Object.entries(raw)
    .map(([k, v]) => `${k}={${JSON.stringify(v)}}`)
    .join(" ");
  let tree: JsxTree;
  try {
    tree = jsxToTrees(`<${tag} ${attrs} />`)[0] as JsxTree;
  } catch (error) {
    if (error instanceof JsxError) throw new ToolFailure(`${nodeId}: ${error.message}`);
    throw error;
  }
  // jsxToTrees fills in what a new layer needs (a starting box, hugging, wrapping):
  // keep only what each attribute asked for.
  const asked = new Set<string>();
  for (const name of Object.keys(raw)) {
    for (const prop of Object.keys(expandOne(node.type as LayerType, name, raw[name])))
      asked.add(prop);
  }
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tree.props)) if (asked.has(name)) props[name] = value;
  return props as Props;
}

// ---------------------------------------------------------------------------
// The tools

const render = defineTool({
  name: "render",
  title: "Render layers from JSX",
  level: "write",
  description: [
    "Builds layers from JSX in one step: the best way to design a screen, a card or a component.",
    `Elements: ${JSX_TAGS.join(", ")}. Text inside <Text> is its text.`,
    'Short attributes: name, x, y, w and h (a number, "hug" or "fill"), flex ("row", "col", "grid"), gap, p/px/py/pt/pr/pb/pl,',
    'justify ("start", "center", "end", "between"), align (children across, or a text\'s alignment), wrap, fill and stroke ("#rrggbb" or a list of paints),',
    'radius (a number or four), smoothing (corner smoothing, 0 to 1; iOS uses 0.6), clip, hidden, opacity (0 to 1), size, weight, font, italic, lineHeight (px, "150%" or "auto"), tracking.',
    "Any model property works by its name too, with JSON in braces: effects={[...]}, strokeWeight={2}.",
    "Auto layout frames hug their content unless given a size; a text given a width wraps.",
    "Pass parentId to build inside a layer (the page by default), index to place it among its siblings, and replaceId to build over a layer you read with get_jsx.",
    "Returns the new layers as JSX with their ids, laid out.",
  ].join(" "),
  input: z.object({
    jsx: z.string().min(1).max(200_000),
    parentId: id.optional(),
    replaceId: id.optional(),
    index: z.number().int().min(0).optional(),
  }),
  run(editor, { jsx, parentId, replaceId, index }) {
    let trees: ReturnType<typeof jsxToTrees>;
    try {
      trees = jsxToTrees(jsx);
    } catch (error) {
      if (error instanceof JsxError) throw new ToolFailure(error.message);
      throw error;
    }
    let parent = parentId ?? editor.s.pageId;
    let at = index;
    if (replaceId) {
      const old = need(editor, replaceId);
      parent = old.parent;
      at = editor.doc.childIds(parent).indexOf(replaceId);
      // Where the old layer was, unless the new one says where to go.
      const first = trees[0];
      if (first && first.props.x === undefined && first.props.y === undefined)
        trees[0] = {
          ...first,
          props: { ...first.props, x: getProp(old.props, "x"), y: getProp(old.props, "y") },
        };
      editor.commit([{ op: "delete", id: replaceId }], "Replace");
    }
    if (!parent) throw new ToolFailure("Open a page first: there's no page to build on.");
    need(editor, parent);
    const ids = editor.createTrees(parent, trees, at === undefined ? {} : { index: at });
    if (ids.length === 0) throw new ToolFailure(`Layers can't go inside ${parent}.`);
    return { data: { ids, jsx: ids.map((i) => nodeToJsx(editor.doc, i)).join("\n") } };
  },
});

/**
 * The most get_jsx returns: more than a model reads at once, and bounded so
 * reading a file of long texts holds a few MB, never the file again
 * (decision 0026).
 */
export const MAX_JSX_CHARS = 2_000_000;

const getJsx = defineTool({
  name: "get_jsx",
  title: "Read layers as JSX",
  level: "read",
  description:
    "A layer and what's inside it, as the JSX render takes, with each layer's id. Read a layer, change the JSX and render it back with replaceId. Deep trees are cut short at depth, with a note on how to read the rest.",
  input: z.object({ id, depth: z.number().int().min(0).max(40).optional() }),
  run(editor, { id: nodeId, depth }) {
    need(editor, nodeId);
    try {
      return {
        data: {
          jsx: nodeToJsx(editor.doc, nodeId, {
            maxChars: MAX_JSX_CHARS,
            ...(depth === undefined ? {} : { depth }),
          }),
        },
      };
    } catch (error) {
      if (error instanceof JsxTooLong)
        throw new ToolFailure(
          `That's more JSX than one read returns (over ${MAX_JSX_CHARS.toLocaleString("en")} characters). Read its layers one at a time by id, or pass a smaller depth.`,
        );
      throw error;
    }
  },
});

/** The longest side `export_image` aims for when not given a scale: what models read well. */
export const EXPORT_IMAGE_FIT = 1536;

const APPROXIMATE: Record<HeadlessPng["approximate"][number], string> = {
  glass: "glass shows only its rim: what's behind it isn't refracted",
  noise: "noise is drawn with a similar but different grain",
  texture: "texture is drawn with a similar but different grain",
  "background-blur": "background blur isn't drawn: what's behind it shows sharp",
};

const exportImage = defineTool({
  name: "export_image",
  title: "Look at layers",
  level: "read",
  description: [
    "Renders a layer, or a whole page by its id, as a PNG you can see: look at your work after render or set_props,",
    "and check spacing, alignment, contrast and text wrapping as a person would.",
    `Without a scale, it's sized to about ${EXPORT_IMAGE_FIT} px on its longest side (up to 2×). If the requested size exceeds the rendering limits, the picture is drawn smaller and \`reduced\` gives the new size. Returns the image, its size,`,
    "and any unavailable font or image. An image too large to draw here gets a grey placeholder.",
  ].join(" "),
  input: z.object({
    id,
    scale: z.number().min(0.05).max(4).optional(),
    background: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "a hex colour, like #ffffff")
      .optional(),
    locale: z
      .string()
      .max(64)
      .regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i)
      .describe("The viewer's BCP 47 locale for regional Han glyphs, for example zh-TW.")
      .optional(),
  }),
  async run(editor, { id: nodeId, scale, background, locale }, services) {
    need(editor, nodeId);
    if (!services.renderPng) throw new ToolFailure("Images can't be rendered here.");
    let png: HeadlessPng;
    try {
      png = await services.renderPng(
        nodeId,
        {
          ...(scale === undefined ? { fit: EXPORT_IMAGE_FIT } : { scale }),
          background: background ?? null,
        },
        locale,
      );
    } catch (error) {
      if (error instanceof ExportError) throw new ToolFailure(error.message);
      throw error;
    }
    const notes = [
      ...png.approximate.map((a) => APPROXIMATE[a]),
      ...png.missingFonts.map((f) => `${f} isn't available, so its text is drawn in the fallback`),
      ...(png.fallbackText ? ["Some text uses fallback glyph outlines."] : []),
      ...(png.reducedImages?.length
        ? [`${png.reducedImages.length} image(s) were drawn at a lower resolution to fit.`]
        : []),
      ...(png.missingImages.length > 0
        ? [`${png.missingImages.length} image(s) couldn't be loaded and are left out`]
        : []),
      ...(png.skippedImages.length > 0
        ? [
            `${png.skippedImages.length} image(s) are too large to draw here and appear as grey placeholders (${png.skippedImages.join(", ")}).`,
          ]
        : []),
    ];
    const reduced = png.reduced;
    return {
      data: {
        id: nodeId,
        width: png.width,
        height: png.height,
        scale: png.scale,
        bounds: png.bounds,
        ...(reduced
          ? {
              reduced: `Drawn smaller than asked, at ${png.width} × ${png.height} (scale ${png.scale}) instead of ${reduced.width} × ${reduced.height} (scale ${reduced.scale}). The full size exceeds the rendering limits. Export a smaller layer to see it in more detail.`,
            }
          : {}),
        ...(notes.length > 0 ? { approximate: notes } : {}),
      },
      image: { mimeType: "image/png", base64: base64(png.png) },
    };
  },
});

const setProps = defineTool({
  name: "set_props",
  title: "Change layer properties",
  level: "write",
  description:
    'Changes properties of several layers at once: [{ "id": "…", "props": { "fill": "#2563eb", "gap": 16, "w": "fill" } }]. Takes the same attributes as render (model properties by name, or the short forms). All or nothing: if any change is invalid, none is made, and the error says which.',
  input: z.object({
    changes: z
      .array(z.object({ id, props: z.record(z.string(), z.unknown()) }))
      .min(1)
      .max(500),
  }),
  run(editor, { changes }) {
    // Every change is checked before any is made.
    const planned = changes.map(({ id: nodeId, props }) => ({
      id: nodeId,
      props: checkedProps(editor, nodeId, props),
    }));
    const ops = planned.flatMap(({ id: nodeId, props }) =>
      Object.entries(props).map(
        ([prop, value]): Op => ({ op: "set", id: nodeId, prop: prop as PropName, value }),
      ),
    );
    if (ops.length > 0) editor.commit(ops, "Change properties");
    return { data: { changed: planned.map((p) => p.id) } };
  },
});

const deleteNodes = defineTool({
  name: "delete_nodes",
  title: "Delete layers",
  level: "write",
  description:
    "Deletes layers and what's inside them. Fails, deleting nothing, if any id is unknown.",
  input: z.object({ ids: z.array(id).min(1).max(500) }),
  run(editor, { ids }) {
    for (const nodeId of ids) {
      const node = need(editor, nodeId);
      if (node.type === "page" && editor.doc.pageIds().length === 1)
        throw new ToolFailure("A file keeps at least one page.");
    }
    // A layer inside another being deleted goes with it.
    const set = new Set(ids);
    const topmost = ids.filter(
      (nodeId) => !editor.doc.ancestors(nodeId).some((a) => set.has(a.id)),
    );
    editor.commit(
      topmost.map((nodeId) => ({ op: "delete" as const, id: nodeId })),
      "Delete",
    );
    return { data: { deleted: topmost } };
  },
});

const moveNodes = defineTool({
  name: "move_nodes",
  title: "Move layers into another layer",
  level: "write",
  description:
    "Moves layers into a parent (a frame, a group or the page), before the child at index (on top by default), keeping where they are on the canvas unless the parent lays them out.",
  input: z.object({
    ids: z.array(id).min(1).max(500),
    parentId: id,
    index: z.number().int().min(0).optional(),
  }),
  run(editor, { ids, parentId, index }) {
    const parent = need(editor, parentId);
    if (parent.type !== "frame" && parent.type !== "group" && parent.type !== "page")
      throw new ToolFailure(
        `${parentId} is a ${parent.type}: only frames, groups and pages hold layers.`,
      );
    for (const nodeId of ids) {
      need(editor, nodeId);
      if (nodeId === parentId || editor.doc.ancestors(parentId).some((a) => a.id === nodeId))
        throw new ToolFailure(`${nodeId} can't move inside itself.`);
    }
    const siblings = editor.doc.childIds(parentId).filter((c) => !ids.includes(c));
    const at = Math.min(index ?? siblings.length, siblings.length);
    const before = at > 0 ? (editor.doc.get(siblings[at - 1] as string)?.key ?? null) : null;
    const after =
      at < siblings.length ? (editor.doc.get(siblings[at] as string)?.key ?? null) : null;
    const keys = keysBetween(before, after, ids.length);
    const ops = ids.flatMap((nodeId, i) => editor.reparentOps(nodeId, parentId, keys[i] as string));
    editor.commit(ops, "Move");
    return { data: { moved: ids, parentId } };
  },
});

const setVariableMode = defineTool({
  name: "set_variable_mode",
  title: "Set a variable mode",
  level: "write",
  description:
    "Sets which mode of a variable collection (Light or Dark of Theme, say) applies inside frames or pages; null goes back to inheriting. Read list_tokens for collection and mode ids.",
  input: z.object({ ids: z.array(id).min(1).max(500), collectionId: id, modeId: id.nullable() }),
  run(editor, { ids, collectionId, modeId }) {
    const collection = need(editor, collectionId);
    if (collection.type !== "collection")
      throw new ToolFailure(`${collectionId} isn't a collection.`);
    if (modeId && !getProp(collection.props, "modes").some((m) => m.id === modeId))
      throw new ToolFailure(`${collectionId} has no mode ${modeId}.`);
    for (const nodeId of ids) {
      const node = need(editor, nodeId);
      if (node.type !== "frame" && node.type !== "page")
        throw new ToolFailure(`${nodeId} is a ${node.type}: only frames and pages set modes.`);
    }
    editor.setVariableModes(ids, collectionId, modeId);
    return { data: { ids, collectionId, modeId } };
  },
});

const bindToken = defineTool({
  name: "bind_token",
  title: "Bind a design token",
  level: "write",
  description:
    "Binds a variable (a design token) to a property of layers, so they follow it in every mode: fill, stroke, width, height, gap, padding, radius, opacity, fontSize or text. Read list_tokens for variable ids.",
  input: z.object({ ids: z.array(id).min(1).max(500), key: z.enum(BINDING_KEYS), variableId: id }),
  run(editor, { ids, key, variableId }) {
    const variable = need(editor, variableId);
    if (variable.type !== "variable") throw new ToolFailure(`${variableId} isn't a variable.`);
    for (const nodeId of ids) need(editor, nodeId);
    const before = JSON.stringify(ids.map((i) => editor.doc.get(i)?.props.bindings ?? null));
    editor.bindVariable(ids, key as BindingKey, variableId);
    const after = JSON.stringify(ids.map((i) => editor.doc.get(i)?.props.bindings ?? null));
    if (before === after)
      throw new ToolFailure(
        `Couldn't bind ${key}: the layers don't have that property, or the variable's type doesn't fit it (keys: ${BINDING_KEYS.join(", ")}).`,
      );
    return { data: { ids, key, variableId } };
  },
});

/** Every tool, in the order models see them. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getJsx,
  exportImage,
  render,
  setProps,
  moveNodes,
  deleteNodes,
  bindToken,
  setVariableMode,
] as AgentTool[];

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/**
 * Runs a tool on an editor. Its input is checked against its schema first.
 * A write tool is one transaction: one undo step, labelled with the tool; if
 * it fails, what it did is reverted and the failure is thrown.
 */
export async function runTool(
  editor: Editor,
  name: string,
  rawInput: unknown,
  services: ToolServices = {},
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) throw new ToolFailure(`There's no tool called ${name}.`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ToolFailure(
      `${name}: ${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "the input isn't valid"}`,
    );
  }
  if (tool.level !== "write") return tool.run(editor, parsed.data, services);
  if (!editor.canEdit) throw new ToolFailure("This file is view-only for you.");
  editor.beginGesture(tool.title);
  try {
    const result = await tool.run(editor, parsed.data, services);
    editor.endGesture();
    return result;
  } catch (error) {
    editor.cancelGesture();
    throw error;
  }
}
