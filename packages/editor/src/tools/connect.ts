/**
 * Drawing prototype connections. With the Prototype tab open, the selected
 * layer shows a round handle on its right edge; drag it onto a screen to make
 * tapping the layer go there. The overlay draws the live curve from
 * `state.connecting`.
 */
import type { Editor } from "../editor";
import type { Point } from "../geometry";
import type { PointerInput } from "../interaction";
import { connectToScreen } from "../prototype/commands";
import { isScreen, screenOf } from "../prototype/screens";
import type { KeyInput, ToolHandler } from "./types";

/** Screen-space radius of the handle's pick area (the dot itself is smaller). */
const HANDLE_PICK_PX = 9;

/** Where the connection handle sits on screen: the middle of the selected layer's right edge. */
export function connectionHandle(editor: Editor): Point | null {
  const { selection, prototyping, camera, editingText, vectorEdit } = editor.s;
  if (!prototyping || selection.length !== 1 || editingText || vectorEdit) return null;
  const id = selection[0] as string;
  if (!screenOf(editor.doc, id)) return null;
  const b = editor.scene.bounds(id);
  if (!b) return null;
  return camera.toScreen({ x: b.x + b.width, y: b.y + b.height / 2 });
}

/** The screen under a page point that a connection from `from` could go to. */
export function connectionTarget(editor: Editor, from: string, p: Point): string | null {
  const { pageId } = editor.s;
  if (!pageId) return null;
  const own = screenOf(editor.doc, from);
  const ids = editor.doc.childIds(pageId);
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i] as string;
    if (!isScreen(editor.doc, id) || editor.doc.get(id)?.props.visible === false) continue;
    const b = editor.scene.bounds(id);
    if (b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height)
      return id === own ? null : id;
  }
  return null;
}

export class ConnectTool implements ToolHandler {
  readonly #editor: Editor;
  #from: string | null = null;
  cursor = "default";

  constructor(editor: Editor) {
    this.#editor = editor;
  }

  get busy(): boolean {
    return this.#from !== null;
  }

  #overHandle(screen: Point): boolean {
    const handle = connectionHandle(this.#editor);
    return (
      handle !== null && Math.hypot(handle.x - screen.x, handle.y - screen.y) <= HANDLE_PICK_PX
    );
  }

  down(input: PointerInput): boolean {
    const editor = this.#editor;
    if (!editor.canEdit || input.button !== 0 || !this.#overHandle(input.screen)) return false;
    this.#from = editor.s.selection[0] as string;
    const pointer = editor.s.camera.toPage(input.screen);
    editor.state.set({ connecting: { from: this.#from, pointer, target: null }, hover: null });
    this.cursor = "crosshair";
    return true;
  }

  move(input: PointerInput): boolean {
    const editor = this.#editor;
    if (!this.#from) {
      if (!editor.canEdit || !this.#overHandle(input.screen)) return false;
      this.cursor = "crosshair";
      editor.state.set({ hover: null });
      return true;
    }
    const pointer = editor.s.camera.toPage(input.screen);
    const target = connectionTarget(editor, this.#from, pointer);
    editor.state.set({ connecting: { from: this.#from, pointer, target }, hover: target });
    return true;
  }

  up(_input: PointerInput): boolean {
    const editor = this.#editor;
    const from = this.#from;
    if (!from) return false;
    const target = editor.s.connecting?.target ?? null;
    this.cancel();
    if (target) connectToScreen(editor, from, target);
    return true;
  }

  key(input: KeyInput): boolean {
    if (input.key !== "Escape" || !this.#from) return false;
    this.cancel();
    return true;
  }

  cancel(): void {
    if (!this.#from) return;
    this.#from = null;
    this.cursor = "default";
    this.#editor.state.set({ connecting: null, hover: null });
  }
}
