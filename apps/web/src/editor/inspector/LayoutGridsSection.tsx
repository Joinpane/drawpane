/**
 * Layout grids on a frame: columns, rows or a square grid. Like effects
 * (ItemList.tsx): "+" offers the kinds, each grid is a row (kind, count,
 * alignment), and the row opens its values beside the inspector. They show on the
 * canvas while you design and snap moving layers; exports never include them.
 */
import { defaultLayoutGrid, type Editor } from "@drawpane/editor";
import type { LayoutGrid, NodeRecord } from "@drawpane/model";
import { NumberField, PropertySection } from "@drawpane/ui";
import { ColorRow } from "./ColorRow";
import { common, Select } from "./fields";
import { AddItemButton, ItemEditor, type ItemKind, ItemRow, useItemEditor } from "./ItemList";
import { moveItem, remapIndex, useReorder } from "./reorder";

type TrackGrid = Extract<LayoutGrid, { type: "columns" | "rows" }>;

/**
 * The kinds of grid, columns first, like Figma. The icons are auto layout's:
 * a row of items is vertical bars side by side, which is what columns look like.
 */
const GRID_KINDS: ReadonlyArray<ItemKind<LayoutGrid["type"]>> = [
  { type: "columns", label: "Columns", icon: "layout-row" },
  { type: "rows", label: "Rows", icon: "layout-col" },
  { type: "grid", label: "Grid", icon: "layout-grid" },
];
const KIND = Object.fromEntries(GRID_KINDS.map((k) => [k.type, k])) as Record<
  LayoutGrid["type"],
  ItemKind<LayoutGrid["type"]>
>;

const ALIGNMENT_LABEL: Record<TrackGrid["alignment"], (rows: boolean) => string> = {
  stretch: () => "Stretch",
  start: (rows) => (rows ? "Top" : "Left"),
  center: () => "Center",
  end: (rows) => (rows ? "Bottom" : "Right"),
};

/** "Columns · 12 · stretch", "Grid · 8px". */
function summary(grid: LayoutGrid): string {
  if (grid.type === "grid") return `${grid.size}px`;
  return `${grid.count} · ${ALIGNMENT_LABEL[grid.alignment](grid.type === "rows").toLowerCase()}`;
}

/** Changing a grid's kind keeps what carries over (color, visibility, the track settings). */
function withKind(grid: LayoutGrid, type: LayoutGrid["type"]): LayoutGrid {
  const keep = { color: grid.color, ...(grid.visible === false ? { visible: false } : {}) };
  if (type === "grid") return { ...defaultLayoutGrid("grid"), ...keep } as LayoutGrid;
  if (grid.type === "grid") return { ...defaultLayoutGrid(type), ...keep } as LayoutGrid;
  return { ...grid, type };
}

export function LayoutGridsSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const grids = common(nodes, "layoutGrids");
  const items = useItemEditor(ids.join(","), grids?.length ?? 0);
  const set = (next: LayoutGrid[], label: string) =>
    editor.setProp(ids, "layoutGrids", next.length ? next : null, label);
  const replace = (i: number, next: LayoutGrid, label: string) =>
    set(
      (grids ?? []).map((g, j) => (j === i ? next : g)),
      label,
    );
  const current = items.open === null ? null : (grids?.[items.open] ?? null);
  const { rowProps } = useReorder({
    order: (grids ?? []).map((_, i) => i),
    onMove: (from, to) => {
      if (!grids) return;
      set(moveItem(grids, from, to), "Reorder layout grids");
      items.setOpen((open) => (open === null ? null : remapIndex(open, from, to)));
    },
  });

  return (
    <PropertySection
      title="Layout grids"
      actions={
        <AddItemButton
          label="Add layout grid"
          kinds={GRID_KINDS}
          onAdd={(type) => {
            const list = grids ?? [];
            set([...list, defaultLayoutGrid(type)], "Add layout grid");
            items.openNew(list.length);
            // Grids show while they're being set up.
            if (!editor.s.layoutGrids) editor.state.set({ layoutGrids: true });
          }}
        />
      }
    >
      {grids === null ? (
        <p className="inspector__mixed">Mixed grids. Add one to replace them.</p>
      ) : (
        grids.map((grid, i) => (
          <ItemRow
            key={i}
            kind={KIND[grid.type]}
            summary={summary(grid)}
            hidden={grid.visible === false}
            open={items.open === i}
            buttonRef={items.rowRef(i)}
            onOpen={() => items.toggle(i)}
            onToggleHidden={() =>
              replace(i, { ...grid, visible: grid.visible === false }, "Toggle layout grid")
            }
            onRemove={() => {
              set(
                grids.filter((_, j) => j !== i),
                "Remove layout grid",
              );
              items.setOpen(null);
            }}
            reorder={rowProps(i)}
          />
        ))
      )}
      {items.anchor && current && items.open !== null ? (
        <ItemEditor
          anchor={items.anchor}
          kinds={GRID_KINDS}
          current={current.type}
          kindLabel="Layout grid type"
          onKind={(type) =>
            replace(items.open as number, withKind(current, type), "Layout grid type")
          }
          onClose={() => items.setOpen(null)}
        >
          <GridFields
            editor={editor}
            grid={current}
            onChange={(next, label) => replace(items.open as number, next, label)}
          />
        </ItemEditor>
      ) : null}
    </PropertySection>
  );
}

/** A grid's values, each with its name. */
function GridFields({
  editor,
  grid,
  onChange,
}: {
  editor: Editor;
  grid: LayoutGrid;
  onChange: (next: LayoutGrid, label: string) => void;
}) {
  const scrub = (label: string) => ({
    onScrubStart: () => editor.beginGesture(label),
    onScrubEnd: () => editor.endGesture(),
  });
  return (
    <div className="item-editor__fields">
      {grid.type === "grid" ? (
        <>
          <span className="item-editor__label">Size</span>
          <NumberField
            icon="layout-grid"
            unit="px"
            ariaLabel="Grid size"
            min={1}
            value={grid.size}
            onChange={(size) => onChange({ ...grid, size: Math.max(1, size) }, "Grid size")}
            {...scrub("Grid size")}
          />
        </>
      ) : (
        <TrackFields grid={grid} onChange={onChange} scrub={scrub} />
      )}
      <span className="item-editor__label">Color</span>
      <ColorRow
        editor={editor}
        label="Grid"
        color={grid.color}
        onChange={(color, label) => onChange({ ...grid, color }, label)}
      />
    </div>
  );
}

function TrackFields({
  grid,
  onChange,
  scrub,
}: {
  grid: TrackGrid;
  onChange: (next: LayoutGrid, label: string) => void;
  scrub: (label: string) => { onScrubStart: () => void; onScrubEnd: () => void };
}) {
  const rows = grid.type === "rows";
  const noun = rows ? "Row" : "Column";
  return (
    <>
      <span className="item-editor__label">Count</span>
      <NumberField
        label="#"
        ariaLabel={`${noun} count`}
        min={1}
        max={100}
        precision={0}
        value={grid.count}
        onChange={(count) =>
          onChange(
            { ...grid, count: Math.min(100, Math.max(1, Math.round(count))) },
            `${noun} count`,
          )
        }
        {...scrub(`${noun} count`)}
      />
      <span className="item-editor__label">Type</span>
      <Select
        label={`${noun} alignment`}
        value={grid.alignment}
        options={(["stretch", "start", "center", "end"] as const).map((a) => ({
          value: a,
          label: ALIGNMENT_LABEL[a](rows),
        }))}
        onChange={(alignment) => onChange({ ...grid, alignment }, `${noun} alignment`)}
      />
      {grid.alignment === "stretch" ? (
        <>
          <span className="item-editor__label">Margin</span>
          <NumberField
            label="M"
            ariaLabel="Margin"
            min={0}
            value={grid.margin}
            onChange={(margin) => onChange({ ...grid, margin: Math.max(0, margin) }, "Grid margin")}
            {...scrub("Grid margin")}
          />
        </>
      ) : (
        <>
          <span className="item-editor__label">{rows ? "Height" : "Width"}</span>
          <NumberField
            label={rows ? "H" : "W"}
            ariaLabel={rows ? "Row height" : "Column width"}
            min={0}
            value={grid.size}
            onChange={(size) => onChange({ ...grid, size: Math.max(0, size) }, `${noun} size`)}
            {...scrub(`${noun} size`)}
          />
        </>
      )}
      <span className="item-editor__label">Gutter</span>
      <NumberField
        label="G"
        ariaLabel="Gutter"
        min={0}
        value={grid.gutter}
        onChange={(gutter) => onChange({ ...grid, gutter: Math.max(0, gutter) }, "Grid gutter")}
        {...scrub("Grid gutter")}
      />
      {grid.alignment !== "stretch" && grid.alignment !== "center" ? (
        <>
          <span className="item-editor__label">Offset</span>
          <NumberField
            label="M"
            ariaLabel="Offset"
            min={0}
            value={grid.margin}
            onChange={(margin) => onChange({ ...grid, margin: Math.max(0, margin) }, "Grid offset")}
            {...scrub("Grid offset")}
          />
        </>
      ) : null}
    </>
  );
}
