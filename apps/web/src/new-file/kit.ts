/**
 * A small vocabulary for authoring templates on a scratch editor: frames,
 * stacks (auto layout), text, shapes, colour variables and text styles, each
 * created through the editor so layout and sizing happen as they would by
 * hand. Positions are in the parent's coordinates, as a designer reads them. Kept tiny on purpose: templates read like the screens they draw.
 */
import type { Editor } from "@drawpane/editor";
import type { Paint } from "@drawpane/model";

type Props = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };

export const solid = (color: string): Paint[] => [{ type: "solid", color }];

export interface Kit {
  readonly editor: Editor;
  frame(parent: string, rect: Rect, props?: Props): string;
  /** An auto layout frame: `direction` row or column, sized to its content unless told. */
  stack(
    parent: string,
    direction: "row" | "column",
    props?: Props & { x?: number; y?: number; width?: number; height?: number },
  ): string;
  text(parent: string, characters: string, props?: Props & { x?: number; y?: number }): string;
  rect(parent: string, rect: Rect, props?: Props): string;
  ellipse(parent: string, rect: Rect, props?: Props): string;
  /** A colour variable in the file's "Colors" collection (made on first use). */
  color(name: string, value: string): string;
  /** Fills these layers with the variable (bound, so editing the colour updates them). */
  paint(ids: readonly string[], variable: string): void;
  /** A text style from `from`'s typography, applied to `apply` too. */
  style(name: string, from: string, apply?: readonly string[]): void;
}

export function kit(editor: Editor): Kit {
  let collection: string | null = null;
  const create = (
    type: Parameters<Editor["createLayer"]>[0],
    rect: Rect,
    parent: string,
    props: Props,
  ) => {
    // Templates place layers in their parent's coordinates; the editor takes page ones.
    const m = editor.scene.spaceMatrix(parent);
    const page = {
      ...rect,
      x: m[0] * rect.x + m[2] * rect.y + m[4],
      y: m[1] * rect.x + m[3] * rect.y + m[5],
    };
    const id = editor.createLayer(type, page, parent, props as never);
    if (!id) throw new Error(`Couldn't create a ${type} in a template.`);
    return id;
  };
  return {
    editor,
    frame: (parent, rect, props = {}) =>
      create("frame", rect, parent, { clipContent: true, ...props }),
    stack: (parent, direction, props = {}) => {
      const { x = 0, y = 0, width = 10, height = 10, ...rest } = props;
      const sized = props.width !== undefined || props.height !== undefined;
      return create("frame", { x, y, width, height }, parent, {
        layoutMode: direction,
        clipContent: false,
        fills: [],
        ...(sized ? {} : { sizingH: "hug", sizingV: "hug" }),
        ...rest,
      });
    },
    text: (parent, characters, props = {}) => {
      const { x = 0, y = 0, ...rest } = props;
      return create("text", { x, y, width: 10, height: 10 }, parent, { characters, ...rest });
    },
    rect: (parent, rect, props = {}) => create("rect", rect, parent, props),
    ellipse: (parent, rect, props = {}) => create("ellipse", rect, parent, props),
    color: (name, value) => {
      collection ??= editor.createCollection("Colors");
      if (!collection) throw new Error("Couldn't make the template's colours.");
      const id = editor.createVariable(collection, name, "color", value);
      if (!id) throw new Error(`Couldn't make the colour ${name}.`);
      return id;
    },
    paint: (ids, variable) => editor.bindVariable(ids, "fill", variable),
    style: (name, from, apply = []) => {
      editor.select([from, ...apply]);
      editor.createTextStyle(name, from);
      editor.select([]);
    },
  };
}
