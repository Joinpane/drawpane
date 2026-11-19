/**
 * What the kit parity harness (tools/kit-parity, e2e/kit-parity.spec.ts)
 * reads from an open file: a layer's fonts made ready and checked, its
 * layout as the editor has it, and its picture drawn over an exact page rect
 * by the canvas renderer, as an export draws it. Attached to the debug
 * handle only (`drawpaneParity`).
 */
import {
  CanvasRenderer,
  type Editor,
  exportBounds,
  imageRefs,
  layoutText,
  layoutTextNode,
  type Rect,
  textFaces,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { fonts } from "../fonts/fonts";
import { imagesFor } from "./media";

/** A layer as laid out: page coordinates, axis-aligned. */
export interface ParityNode {
  readonly id: string;
  readonly parent: string | null;
  readonly type: string;
  readonly name: string;
  readonly visible: boolean;
  readonly box: Rect | null;
  /** What it paints, its children included unless it clips them. */
  readonly extent: Rect | null;
  /** For text: the faces it's set in. */
  readonly faces?: readonly string[];
  /**
   * For text, as Drawpane measures it: the width its widest line takes
   * unwrapped, and how many lines it breaks into in its box.
   */
  readonly text?: { readonly width: number; readonly lines: number };
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const round = (r: Rect | null): Rect | null =>
  r && {
    x: Math.round(r.x * 1000) / 1000,
    y: Math.round(r.y * 1000) / 1000,
    width: Math.round(r.width * 1000) / 1000,
    height: Math.round(r.height * 1000) / 1000,
  };

export function parityDebug(editor: Editor) {
  const subtree = (id: string): string[] => {
    const out: string[] = [];
    const visit = (n: string) => {
      out.push(n);
      for (const c of editor.doc.childIds(n)) visit(c);
    };
    if (editor.doc.get(id)) visit(id);
    return out;
  };
  let renderer: CanvasRenderer | null = null;

  return {
    /** Whether the layer is in the document. */
    has: (id: string) => editor.doc.get(id) !== undefined && editor.doc.get(id) !== null,

    /**
     * Loads every face the layer's text uses, as opening a file does, and
     * lists those the browser still can't draw (missing: drawn in a fallback).
     */
    async fonts(id: string): Promise<{ faces: string[]; missing: string[] }> {
      const faces = new Map<string, { family: string; weight: number; italic: boolean }>();
      for (const n of subtree(id)) {
        const node = editor.doc.get(n);
        if (node?.type !== "text") continue;
        for (const f of textFaces(node))
          faces.set(`${f.family}/${f.weight}${f.italic ? "i" : ""}`, f);
      }
      const missing: string[] = [];
      for (const [key, f] of faces) {
        const found = await fonts.ensure(f.family, [{ weight: f.weight, italic: f.italic }]);
        const css = `${f.italic ? "italic " : ""}${f.weight} 16px "${f.family}"`;
        if (!found || !document.fonts.check(css)) missing.push(key);
      }
      await document.fonts.ready;
      return { faces: [...faces.keys()].sort(), missing };
    },

    /** The layer and everything in it, as the editor lays it out. */
    layout(id: string): ParityNode[] {
      const scene = editor.scene;
      return subtree(id).map((n) => {
        const node = editor.doc.get(n);
        if (!node) throw new Error(`No layer ${n}`);
        return {
          id: n,
          parent: n === id ? null : node.parent,
          type: node.type,
          name: getProp(node.props, "name") ?? "",
          visible: node.props.visible !== false,
          box: round(scene.bounds(n)),
          extent: round(scene.extent(n)),
          ...(node.type === "text"
            ? {
                faces: textFaces(node).map((f) => `${f.family}/${f.weight}${f.italic ? "i" : ""}`),
                text: {
                  width: Math.round(layoutText(node, editor.measurer, null).width * 1000) / 1000,
                  lines: layoutTextNode(node, editor.measurer).lines.length,
                },
              }
            : {}),
        };
      });
    },

    /**
     * The layer drawn alone over `rect` (page coordinates) at `scale`, into
     * a canvas of `width` × `height`: a PNG (base64). Waits for its images.
     */
    async render(
      id: string,
      rect: Rect,
      scale: number,
      width: number,
      height: number,
    ): Promise<{ png: string; ms: number; bounds: Rect | null }> {
      renderer ??= new CanvasRenderer(editor.scene, editor.measurer, {
        images: imagesFor(editor),
      });
      await renderer.images.ready(imageRefs(editor.doc, [id]), 30_000);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D context");
      const started = performance.now();
      renderer.renderNodes(ctx, [id], rect, scale, null, false, true);
      const ms = Math.round(performance.now() - started);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return {
        png: toBase64(new Uint8Array(await blob.arrayBuffer())),
        ms,
        bounds: round(exportBounds(editor.scene, [id])),
      };
    },
  };
}
