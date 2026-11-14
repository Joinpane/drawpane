import {
  Camera,
  CanvasRenderer,
  componentSetOf,
  isComponentSet,
  listComponents,
  variantsOf,
} from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Icon } from "@drawpane/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useResolvedTheme } from "../app/theme";
import { shortcutFor } from "./actions";
import { useDocVersion, useEditor } from "./hooks";

export const COMPONENT_DRAG_MIME = "application/x-drawpane-component";

/**
 * The file's components: search, preview, click to insert an instance, or
 * drag one onto the canvas.
 */
export function AssetsPanel() {
  const editor = useEditor();
  const version = useDocVersion();
  const [query, setQuery] = useState("");
  // Variants show as one tile for their set; clicking inserts the first variant.
  const components = useMemo(() => {
    void version;
    const out: NodeRecord[] = [];
    const seenSets = new Set<string>();
    for (const c of listComponents(editor.doc)) {
      const set = componentSetOf(editor.doc, c.id);
      if (!set) out.push(c);
      else if (!seenSets.has(set.id)) {
        seenSets.add(set.id);
        out.push(set);
      }
    }
    return out;
  }, [editor, version]);
  const q = query.trim().toLowerCase();
  const visible = q
    ? components.filter(
        (c) =>
          getProp(c.props, "name").toLowerCase().includes(q) ||
          getProp(c.props, "componentDescription").toLowerCase().includes(q),
      )
    : components;

  // Group by page, like a library's sections.
  const byPage = new Map<string, NodeRecord[]>();
  for (const c of visible) {
    const page = editor.doc.pageOf(c.id);
    const name = page ? getProp(page.props, "name") || "Page" : "Page";
    const list = byPage.get(name) ?? [];
    list.push(c);
    byPage.set(name, list);
  }

  return (
    <div className="assets">
      <label className="assets__search">
        <Icon name="search" size={12} />
        <input
          type="search"
          placeholder="Search components"
          aria-label="Search components"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <div className="assets__scroll">
        {components.length === 0 ? (
          <div className="assets__empty">
            <p className="assets__empty-title">No components yet</p>
            <p className="assets__empty-body">
              Select a frame and press <kbd>{shortcutFor("component.create")}</kbd> to make it a
              component. Its instances update when it changes.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="assets__empty-body assets__pad">No components match “{query}”.</p>
        ) : (
          [...byPage].map(([page, list]) => (
            <section key={page} className="assets__group" aria-label={page}>
              {byPage.size > 1 ? <h3 className="assets__group-title">{page}</h3> : null}
              <ul className="assets__grid">
                {list.map((c) => (
                  <li key={c.id}>
                    <ComponentTile node={c} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function ComponentTile({ node }: { node: NodeRecord }) {
  const editor = useEditor();
  const name = getProp(node.props, "name") || "Component";
  // A set inserts its first variant.
  const insertId = isComponentSet(node)
    ? (variantsOf(editor.doc, node.id)[0]?.id ?? node.id)
    : node.id;
  const description = getProp(node.props, "componentDescription");
  return (
    <button
      type="button"
      className="assets__tile"
      title={description ? `${name}: ${description}` : name}
      draggable={editor.canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData(COMPONENT_DRAG_MIME, insertId);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => editor.insertInstance(insertId)}
      disabled={!editor.canEdit}
    >
      <ComponentPreview node={node} />
      <span className="assets__name">{name}</span>
    </button>
  );
}

const PREVIEW = { width: 112, height: 72 };

/** A small live render of a component, redrawn when the file changes. */
function ComponentPreview({ node }: { node: NodeRecord }) {
  const editor = useEditor();
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

function topLevelOf(editor: ReturnType<typeof useEditor>, id: string): string {
  let current = editor.doc.get(id);
  while (current) {
    const parent = editor.doc.get(current.parent);
    if (!parent || parent.type === "page") return current.id;
    current = parent;
  }
  return id;
}
