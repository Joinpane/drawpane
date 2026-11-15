/**
 * Variable modes on frames and pages, as Figma sets them: which mode of a
 * collection (Light or Dark of "Theme", say) applies inside. Children inherit
 * from the nearest frame or page that sets one (`modeAt`), so only what a
 * layer sets itself is listed, a row per collection with its mode and a way to
 * stop; "Apply variable mode" adds one. Frames show it in Appearance, pages in
 * a section of their own.
 */
import { type Editor, listCollections } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { IconButton, MenuButton, type MenuItem, PropertyRow, PropertySection } from "@drawpane/ui";
import { useEditor } from "../hooks";
import { Select } from "../inspector/fields";

/** Collections with more than one mode: the only ones a mode can be picked from. */
function switchable(editor: Editor): NodeRecord[] {
  return listCollections(editor.doc).filter((c) => getProp(c.props, "modes").length > 1);
}

/** The mode every layer in `nodes` sets for a collection: its id, "" for none, or null when they differ. */
function setFor(nodes: readonly NodeRecord[], collectionId: string): string | null {
  const values = new Set(nodes.map((n) => getProp(n.props, "variableModes")[collectionId] ?? ""));
  return values.size === 1 ? ([...values][0] as string) : null;
}

/** "Apply variable mode": each collection's modes under its name, the ones set checked. */
export function ApplyModeButton({ nodes }: { nodes: readonly NodeRecord[] }) {
  const editor = useEditor();
  const collections = switchable(editor);
  if (collections.length === 0 || nodes.length === 0) return null;
  const ids = nodes.map((n) => n.id);
  const items: MenuItem[] = collections.flatMap((collection, i) => {
    const current = setFor(nodes, collection.id);
    return [
      ...(i > 0 ? [{ id: `sep-${collection.id}`, separator: true as const }] : []),
      { id: `h-${collection.id}`, heading: getProp(collection.props, "name") || "Collection" },
      ...getProp(collection.props, "modes").map((mode) => ({
        id: `${collection.id}:${mode.id}`,
        label: mode.name,
        checked: current === mode.id,
        onSelect: () => editor.setVariableModes(ids, collection.id, mode.id),
      })),
    ];
  });
  return (
    <MenuButton
      icon="variable-mode"
      label="Apply variable mode"
      menuLabel="Variable modes"
      items={items}
    />
  );
}

/** A row per collection these layers set a mode of: its name, the mode, and a way to stop. */
export function ModeRows({ nodes }: { nodes: readonly NodeRecord[] }) {
  const editor = useEditor();
  const ids = nodes.map((n) => n.id);
  const rows = switchable(editor).filter((c) => setFor(nodes, c.id) !== "");
  return (
    <>
      {rows.map((collection) => {
        const name = getProp(collection.props, "name") || "Collection";
        const current = setFor(nodes, collection.id);
        return (
          <PropertyRow key={collection.id} columns="label" className="mode-row">
            <span className="inspector__label mode-row__name" title={name}>
              {name}
            </span>
            <span className="mode-row__value">
              <Select
                label={`${name} mode`}
                value={current}
                mixed={current === null}
                options={getProp(collection.props, "modes").map((m) => ({
                  value: m.id,
                  label: m.name,
                }))}
                onChange={(mode) => editor.setVariableModes(ids, collection.id, mode)}
              />
              <IconButton
                icon="minus"
                label={`Stop using a ${name} mode`}
                onClick={() => editor.setVariableModes(ids, collection.id, null)}
              />
            </span>
          </PropertyRow>
        );
      })}
    </>
  );
}

/** A page's modes, in a section of its own (a page has no Appearance). */
export function ModesSection({ node }: { node: NodeRecord }) {
  const editor = useEditor();
  if (switchable(editor).length === 0) return null;
  return (
    <PropertySection title="Variable modes" actions={<ApplyModeButton nodes={[node]} />}>
      <ModeRows nodes={[node]} />
    </PropertySection>
  );
}
