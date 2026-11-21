import {
  componentSetOf,
  isComponentSet,
  listComponents,
  usedLibraries,
  variantsOf,
} from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Button, Icon, IconButton } from "@drawpane/ui";
import { useMemo, useState } from "react";
import { shortcutFor } from "./actions";
import { ComponentPreview } from "./ComponentPreview";
import { useDeferredDocVersion, useEditor } from "./hooks";
import { LibrarySections } from "./libraries/LibrarySections";

export const COMPONENT_DRAG_MIME = "application/x-drawpane-component";

/**
 * The file's components: search, preview, click to insert an instance, or
 * drag one onto the canvas.
 */
export function AssetsPanel({ onLibraries }: { onLibraries: () => void }) {
  const editor = useEditor();
  const version = useDeferredDocVersion();
  const [query, setQuery] = useState("");
  const usesLibraries = useMemo(() => usedLibraries(editor.doc).length > 0, [editor, version]);
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
      <div className="assets__bar">
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
        <IconButton icon="book" label="Team libraries" onClick={onLibraries} />
      </div>
      <div className="assets__scroll">
        {usesLibraries && (components.length > 0 || !q) ? (
          <h3 className="assets__heading">This file</h3>
        ) : null}
        {components.length === 0 && usesLibraries ? (
          q ? null : (
            <p className="assets__empty-body assets__note">
              No components of its own. Press <kbd>{shortcutFor("component.create")}</kbd> on a
              frame to make one.
            </p>
          )
        ) : components.length === 0 ? (
          <div className="assets__empty">
            <p className="assets__empty-title">No components yet</p>
            <p className="assets__empty-body">
              Select a frame and press <kbd>{shortcutFor("component.create")}</kbd> to make it a
              component. Its instances update when it changes.
            </p>
            <Button variant="secondary" size="sm" onClick={onLibraries}>
              Browse team libraries
            </Button>
          </div>
        ) : visible.length === 0 ? (
          usesLibraries ? null : (
            <p className="assets__empty-body assets__pad">No components match “{query}”.</p>
          )
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
        <LibrarySections query={query} />
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
