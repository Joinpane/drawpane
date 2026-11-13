/**
 * Layout grids on a frame: columns, rows or a square grid, each a summary
 * row (kind, count, alignment) that opens to its values. They show on the
 * canvas while you design and snap moving layers; exports never include them.
 */
import { defaultLayoutGrid, type Editor } from "@drawpane/editor";
import type { LayoutGrid, NodeRecord } from "@drawpane/model";
import {
  Icon,
  IconButton,
  type IconName,
  NumberField,
  PropertyRow,
  PropertySection,
} from "@drawpane/ui";
import { useState } from "react";
import { ColorRow } from "./ColorRow";
import { common, Select } from "./fields";

type TrackGrid = Extract<LayoutGrid, { type: "columns" | "rows" }>;

const KIND: Record<LayoutGrid["type"], { label: string; icon: IconName }> = {
  columns: { label: "Columns", icon: "layout-col" },
  rows: { label: "Rows", icon: "layout-row" },
  grid: { label: "Grid", icon: "layout-grid" },
};

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
  const [open, setOpen] = useState<number | null>(null);
  const set = (next: LayoutGrid[], label: string) =>
    editor.setProp(ids, "layoutGrids", next.length ? next : null, label);
  const replace = (i: number, next: LayoutGrid, label: string) =>
    set(
      (grids ?? []).map((g, j) => (j === i ? next : g)),
      label,
    );

  return (
    <PropertySection
      title="Layout grids"
      actions={
        <IconButton
          icon="plus"
          label="Add layout grid"
          onClick={() => {
            const list = grids ?? [];
            // Columns first, like Figma; then rows, then a square grid.
            const kinds = list.map((g) => g.type);
            const type = !kinds.includes("columns")
              ? "columns"
              : !kinds.includes("rows")
                ? "rows"
                : "grid";
            set([...list, defaultLayoutGrid(type)], "Add layout grid");
            setOpen(list.length);
            if (!editor.s.layoutGrids) editor.state.set({ layoutGrids: true });
          }}
        />
      }
    >
      {grids === null ? (
        <p className="inspector__mixed">Mixed grids. Add one to replace them.</p>
      ) : (
        grids.map((grid, i) => {
          const expanded = open === i;
          const kind = KIND[grid.type];
          return (
            <div key={i} className="effect" data-hidden={grid.visible === false || undefined}>
              <div className="effect__row">
                <button
                  type="button"
                  className="effect__toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : i)}
                >
                  <span className="layout-grid__icon" aria-hidden="true">
                    <Icon name={kind.icon} size={12} />
                  </span>
                  <span className="effect__name">{kind.label}</span>
                  <span className="effect__summary">{summary(grid)}</span>
                </button>
                <IconButton
                  icon={grid.visible === false ? "eye-off" : "eye"}
                  label={grid.visible === false ? "Show layout grid" : "Hide layout grid"}
                  onClick={() =>
                    replace(i, { ...grid, visible: grid.visible === false }, "Toggle layout grid")
                  }
                />
                <IconButton
                  icon="minus"
                  label="Remove layout grid"
                  onClick={() => {
                    set(
                      grids.filter((_, j) => j !== i),
                      "Remove layout grid",
                    );
                    setOpen(null);
                  }}
                />
              </div>
              {expanded ? (
                <GridDetails
                  editor={editor}
                  grid={grid}
                  onChange={(next, label) => replace(i, next, label)}
                />
              ) : null}
            </div>
          );
        })
      )}
    </PropertySection>
  );
}

function GridDetails({
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
    <div className="effect__details">
      <Select
        label="Layout grid type"
        value={grid.type}
        options={(["columns", "rows", "grid"] as const).map((t) => ({
          value: t,
          label: KIND[t].label,
        }))}
        onChange={(type) => onChange(withKind(grid, type), "Layout grid type")}
      />
      {grid.type === "grid" ? (
        <NumberField
          icon="layout-grid"
          unit="px"
          ariaLabel="Grid size"
          min={1}
          value={grid.size}
          onChange={(size) => onChange({ ...grid, size: Math.max(1, size) }, "Grid size")}
          {...scrub("Grid size")}
        />
      ) : (
        <TrackFields grid={grid} onChange={onChange} scrub={scrub} />
      )}
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
      <PropertyRow>
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
        <Select
          label={`${noun} alignment`}
          value={grid.alignment}
          options={(["stretch", "start", "center", "end"] as const).map((a) => ({
            value: a,
            label: ALIGNMENT_LABEL[a](rows),
          }))}
          onChange={(alignment) => onChange({ ...grid, alignment }, `${noun} alignment`)}
        />
      </PropertyRow>
      <PropertyRow>
        {grid.alignment === "stretch" ? (
          <NumberField
            label="M"
            ariaLabel="Margin"
            min={0}
            value={grid.margin}
            onChange={(margin) => onChange({ ...grid, margin: Math.max(0, margin) }, "Grid margin")}
            {...scrub("Grid margin")}
          />
        ) : (
          <NumberField
            label={rows ? "H" : "W"}
            ariaLabel={rows ? "Row height" : "Column width"}
            min={0}
            value={grid.size}
            onChange={(size) => onChange({ ...grid, size: Math.max(0, size) }, `${noun} size`)}
            {...scrub(`${noun} size`)}
          />
        )}
        <NumberField
          label="G"
          ariaLabel="Gutter"
          min={0}
          value={grid.gutter}
          onChange={(gutter) => onChange({ ...grid, gutter: Math.max(0, gutter) }, "Grid gutter")}
          {...scrub("Grid gutter")}
        />
      </PropertyRow>
      {grid.alignment !== "stretch" && grid.alignment !== "center" ? (
        <NumberField
          label="M"
          ariaLabel="Offset"
          min={0}
          value={grid.margin}
          onChange={(margin) => onChange({ ...grid, margin: Math.max(0, margin) }, "Grid offset")}
          {...scrub("Grid offset")}
        />
      ) : null}
    </>
  );
}
