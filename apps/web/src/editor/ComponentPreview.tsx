/** A component's thumbnail, for the Assets panel: this file's own, or a team library's. */
import { Camera, CanvasRenderer, type Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { useEffect, useMemo, useRef } from "react";
import { useResolvedTheme } from "../app/theme";
import { useDocVersion, useEditor } from "./hooks";

const PREVIEW = { width: 112, height: 72 };

/**
 * A small live render of a component, redrawn when the file changes. From
 * `source` when it's another document's (a library's published snapshot).
 */
export function ComponentPreview({ node, source }: { node: NodeRecord; source?: Editor }) {
  const live = useEditor();
  const editor = source ?? live;
  const version = useDocVersion();
  const ref = useRef<HTMLCanvasElement>(null);
  const renderer = useMemo(() => new CanvasRenderer(editor.scene, editor.measurer), [editor]);
  const theme = useResolvedTheme();
  useEffect(() => {
    void version;
    void theme;
    const canvas = ref.current;
    const page = editor.doc.pageOf(node.id);
    const bounds = editor.scene.bounds(node.id);
    if (!canvas || !page || !bounds) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = PREVIEW.width * dpr;
    canvas.height = PREVIEW.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const camera = new Camera().fit(bounds, PREVIEW, 8, 2);
    renderer.canvasColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface-sunken")
      .trim();
    // Render only this component: hide its siblings on the page for the preview.
    renderer.hidden = new Set(
      editor.doc.childIds(page.id).filter((id) => id !== topLevelOf(editor, node.id)),
    );
    renderer.render(ctx, page.id, camera, PREVIEW, dpr);
  }, [editor, renderer, node.id, version, theme]);
  return <canvas ref={ref} className="assets__preview" style={PREVIEW} />;
}

function topLevelOf(editor: Editor, id: string): string {
  let current = editor.doc.get(id);
  while (current) {
    const parent = editor.doc.get(current.parent);
    if (!parent || parent.type === "page") return current.id;
    current = parent;
  }
  return id;
}
