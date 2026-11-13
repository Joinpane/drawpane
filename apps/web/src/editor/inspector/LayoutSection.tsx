/**
 * Layout in the inspector: a frame's auto layout (row, column, wrap or grid,
 * with gaps, alignment, padding and grid tracks), and how a layer sits in its
 * parent's layout (resizing, absolute position, alignment, grid cell).
 */
import { type Editor, type GridCell, gridGeometry } from "@drawpane/editor";
import { type GridTrack, getProp, type NodeRecord, type PropName } from "@drawpane/model";
import {
  IconButton,
  NumberField,
  PropertyRow,
  PropertySection,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from "@drawpane/ui";
import { common, Num, Select } from "./fields";

type LayoutMode = "none" | "row" | "column" | "grid";
type SelfAlign = "auto" | "start" | "center" | "end" | "stretch";

const parentOf = (editor: Editor, node: NodeRecord) => editor.doc.get(node.parent);

/** The layout mode of a layer's parent frame, or "none". */
export function parentLayout(editor: Editor, node: NodeRecord): LayoutMode {
  const parent = parentOf(editor, node);
  return parent?.type === "frame" ? getProp(parent.props, "layoutMode") : "none";
}

// ---------------------------------------------------------------------------
// The frame: auto layout

const DIRECTIONS: readonly SegmentedOption<LayoutMode>[] = [
  { value: "row", icon: "layout-row", title: "Horizontal" },
  { value: "column", icon: "layout-col", title: "Vertical" },
  { value: "grid", icon: "layout-grid", title: "Grid" },
];

const THIRDS = ["start", "center", "end"] as const;

export function AutoLayoutSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const mode = common(nodes, "layoutMode");
  const on = mode !== "none" && mode !== null;
  const grid = mode === "grid";
  const row = mode === "row";
  const wrap = common(nodes, "layoutWrap");
  const justify = common(nodes, "justifyContent");
  const align = common(nodes, "alignItems");
  const justifyItems = common(nodes, "justifyItems");

  const set = (label: string, changes: ReadonlyArray<[PropName, unknown]>) => {
    editor.beginGesture(label);
    for (const [prop, value] of changes) editor.setProp(ids, prop, value);
    editor.endGesture();
  };

  return (
    <PropertySection
      title="Auto layout"
      actions={
        <IconButton
          icon={on ? "minus" : "plus"}
          label={on ? "Remove auto layout" : "Add auto layout"}
          shortcut="⇧A"
          onClick={() => editor.setLayoutMode(ids, on ? "none" : "row")}
        />
      }
    >
      {on ? (
        <>
          <div className="layout-head">
            <SegmentedControl
              label="Direction"
              options={DIRECTIONS}
              value={mode ?? ""}
              onChange={(value) => editor.setLayoutMode(ids, value)}
            />
            {grid ? null : (
              <IconButton
                icon="wrap"
                label="Wrap"
                pressed={wrap === true}
                onClick={() => editor.setProp(ids, "layoutWrap", !wrap, "Wrap")}
              />
            )}
          </div>
          <PropertyRow>
            <Num
              editor={editor}
              nodes={nodes}
              prop="gap"
              icon={row || grid ? "gap-horizontal" : "gap-vertical"}
              ariaLabel={grid ? "Gap between columns" : "Gap between items"}
            />
            {grid || wrap ? (
              <Num
                editor={editor}
                nodes={nodes}
                prop="rowGap"
                icon={row || grid ? "gap-vertical" : "gap-horizontal"}
                ariaLabel={grid ? "Gap between rows" : "Gap between lines"}
              />
            ) : null}
          </PropertyRow>
          <div className="inspector__layout">
            <fieldset className="inspector__align" aria-label="Alignment">
              {THIRDS.map((a) =>
                THIRDS.map((j) => {
                  if (grid) {
                    // Grids place items in their cells: across (justify) and down (align).
                    const active =
                      justifyItems === j && (align === a || (align === "stretch" && a === "start"));
                    return (
                      <button
                        key={`${a}-${j}`}
                        type="button"
                        className="inspector__align-dot"
                        aria-pressed={active}
                        aria-label={`Items ${j} across, ${a} down`}
                        onClick={() =>
                          set("Alignment", [
                            ["justifyItems", j],
                            ["alignItems", a],
                          ])
                        }
                      />
                    );
                  }
                  // Rows: columns = justify (main axis), rows = align. Columns: transposed.
                  const jj = row ? j : a;
                  const aa = row ? a : j;
                  const active =
                    justify === jj && (align === aa || (align === "stretch" && aa === "start"));
                  return (
                    <button
                      key={`${a}-${j}`}
                      type="button"
                      className="inspector__align-dot"
                      aria-pressed={active}
                      aria-label={`Justify ${jj}, align ${aa}`}
                      onClick={() =>
                        set("Alignment", [
                          ["justifyContent", jj],
                          ["alignItems", aa],
                        ])
                      }
                    />
                  );
                }),
              )}
            </fieldset>
            <div className="inspector__padding">
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingLeft"
                label="L"
                ariaLabel="Left padding"
                min={0}
              />
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingRight"
                label="R"
                ariaLabel="Right padding"
                min={0}
              />
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingTop"
                label="T"
                ariaLabel="Top padding"
                min={0}
              />
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingBottom"
                label="B"
                ariaLabel="Bottom padding"
                min={0}
              />
            </div>
          </div>
          {grid ? (
            <PropertyRow columns="label">
              <span className="inspector__label">Stretch</span>
              <Switch
                label="Fill their cells"
                checked={justifyItems === "stretch" && align === "stretch"}
                onChange={(checked) =>
                  set("Stretch items", [
                    ["justifyItems", checked ? "stretch" : "start"],
                    ["alignItems", checked ? "stretch" : "start"],
                  ])
                }
              />
            </PropertyRow>
          ) : (
            <PropertyRow columns="label">
              <span className="inspector__label">Spread</span>
              <Switch
                label="Space between"
                checked={justify === "space-between"}
                onChange={(checked) =>
                  editor.setProp(
                    ids,
                    "justifyContent",
                    checked ? "space-between" : "start",
                    "Justify",
                  )
                }
              />
            </PropertyRow>
          )}
          {grid ? <GridTracks editor={editor} nodes={nodes} /> : null}
        </>
      ) : null}
    </PropertySection>
  );
}

// ---------------------------------------------------------------------------
// Grid tracks

const UNITS: ReadonlyArray<{ value: GridTrack["unit"]; label: string }> = [
  { value: "px", label: "px" },
  { value: "fr", label: "fr" },
  { value: "auto", label: "Auto" },
];

function GridTracks({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const columns = common(nodes, "gridColumns");
  const rows = common(nodes, "gridRows");
  const first = nodes[0];
  if (!first) return null;
  if (columns === null || rows === null)
    return <p className="inspector__mixed">The selected grids have different tracks.</p>;
  const solved = nodes.length === 1 ? gridGeometry(editor.doc, first.id) : null;
  return (
    <>
      <TrackList
        editor={editor}
        nodes={nodes}
        axis="columns"
        tracks={columns.length > 0 ? columns : [{ unit: "fr", value: 1 }]}
        sizes={solved?.columns.map((t) => t.size) ?? []}
      />
      <TrackList
        editor={editor}
        nodes={nodes}
        axis="rows"
        tracks={rows}
        sizes={solved?.rows.map((t) => t.size) ?? []}
      />
    </>
  );
}

function TrackList({
  editor,
  nodes,
  axis,
  tracks,
  sizes,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  axis: "columns" | "rows";
  tracks: readonly GridTrack[];
  /** Each track's size as laid out now, to keep it when switching to px. */
  sizes: readonly number[];
}) {
  const ids = nodes.map((n) => n.id);
  const prop = axis === "columns" ? "gridColumns" : "gridRows";
  const noun = axis === "columns" ? "Column" : "Row";
  const write = (next: GridTrack[], label: string) => editor.setProp(ids, prop, next, label);
  const replace = (i: number, track: GridTrack) =>
    write(
      tracks.map((t, k) => (k === i ? track : t)),
      `${noun} size`,
    );
  // Columns keep at least one; rows can all go (they then grow to fit).
  const removable = axis === "rows" || tracks.length > 1;
  return (
    <fieldset className="grid-tracks" aria-label={axis === "columns" ? "Columns" : "Rows"}>
      <div className="grid-tracks__head">
        <span className="inspector__label">
          {axis === "columns" ? "Columns" : "Rows"} · {tracks.length > 0 ? tracks.length : "auto"}
        </span>
        <IconButton
          icon="plus"
          size="sm"
          label={`Add ${noun.toLowerCase()}`}
          disabled={tracks.length >= 64}
          onClick={() =>
            write([...tracks, tracks.at(-1) ?? { unit: "auto" }], `Add ${noun.toLowerCase()}`)
          }
        />
      </div>
      {tracks.length === 0 ? (
        <p className="grid-tracks__empty">Rows grow to fit what's in them.</p>
      ) : (
        tracks.map((track, i) => (
          <div key={i} className="grid-tracks__row">
            <span className="grid-tracks__index" aria-hidden="true">
              {i + 1}
            </span>
            <NumberField
              ariaLabel={`${noun} ${i + 1} size`}
              value={track.unit === "auto" ? null : track.value}
              placeholder={sizes[i] !== undefined ? `${Math.round(sizes[i] ?? 0)}` : "Auto"}
              disabled={track.unit === "auto"}
              min={track.unit === "fr" ? 0.01 : 0}
              {...(track.unit === "fr" ? { max: 1000 } : {})}
              step={track.unit === "fr" ? 0.1 : 1}
              onChange={(value) =>
                replace(
                  i,
                  track.unit === "fr"
                    ? { unit: "fr", value: Math.max(0.01, value) }
                    : { unit: "px", value },
                )
              }
              onScrubStart={() => editor.beginGesture(`${noun} size`)}
              onScrubEnd={() => editor.endGesture()}
            />
            <Select
              label={`${noun} ${i + 1} unit`}
              value={track.unit}
              options={UNITS}
              onChange={(unit) =>
                replace(
                  i,
                  unit === "auto"
                    ? { unit: "auto" }
                    : unit === "fr"
                      ? { unit: "fr", value: 1 }
                      : // To px: keep the size it has now.
                        { unit: "px", value: Math.round(sizes[i] ?? 100) },
                )
              }
            />
            <IconButton
              icon="minus"
              size="sm"
              label={`Remove ${noun.toLowerCase()} ${i + 1}`}
              disabled={!removable}
              onClick={() =>
                write(
                  tracks.filter((_, k) => k !== i),
                  `Remove ${noun.toLowerCase()}`,
                )
              }
            />
          </div>
        ))
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// The layer: how it sits in its parent's layout

const SIZING: readonly SegmentedOption[] = [
  { value: "fixed", label: "Fixed" },
  { value: "hug", label: "Hug" },
  { value: "fill", label: "Fill" },
];

const SELF: ReadonlyArray<{ value: SelfAlign; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "start", label: "Start" },
  { value: "center", label: "Center" },
  { value: "end", label: "End" },
  { value: "stretch", label: "Stretch" },
];

/**
 * Resizing (Fixed, Hug, Fill) for layers in auto layout and for layout
 * frames, plus taking a layer out of its parent's flow (absolute position)
 * and, in a row or column, its own cross-axis alignment.
 */
export function SizingSection({
  editor,
  nodes,
  items,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  /** The layers among `nodes` whose parent has auto layout. */
  items: NodeRecord[];
}) {
  const ids = nodes.map((n) => n.id);
  const h = common(nodes, "sizingH");
  const v = common(nodes, "sizingV");
  const allItems = items.length === nodes.length && items.length > 0;
  const absolute = allItems && items.every((n) => getProp(n.props, "positioning") === "absolute");
  const inFlex = allItems && !absolute && items.every((n) => parentLayout(editor, n) !== "grid");
  return (
    <PropertySection
      title="Resizing"
      actions={
        allItems ? (
          <IconButton
            icon="absolute"
            label="Absolute position"
            pressed={absolute}
            onClick={() =>
              editor.setProp(
                items.map((n) => n.id),
                "positioning",
                absolute ? "auto" : "absolute",
                absolute ? "Back in auto layout" : "Absolute position",
              )
            }
          />
        ) : null
      }
    >
      {absolute ? (
        <p className="inspector__mixed">
          Out of the auto layout flow: it stays where you put it, pinned by its constraints.
        </p>
      ) : (
        <>
          <PropertyRow columns="label">
            <span className="inspector__label">Width</span>
            <SegmentedControl
              label="Horizontal resizing"
              options={SIZING}
              value={h ?? ""}
              onChange={(value) => editor.setProp(ids, "sizingH", value, "Resizing")}
            />
          </PropertyRow>
          <PropertyRow columns="label">
            <span className="inspector__label">Height</span>
            <SegmentedControl
              label="Vertical resizing"
              options={SIZING}
              value={v ?? ""}
              onChange={(value) => editor.setProp(ids, "sizingV", value, "Resizing")}
            />
          </PropertyRow>
          {inFlex ? (
            <PropertyRow columns="label">
              <span className="inspector__label">Align self</span>
              <Select
                label="Align self"
                value={common(items, "alignSelf")}
                options={SELF}
                onChange={(value) => editor.setProp(ids, "alignSelf", value, "Align self")}
              />
            </PropertyRow>
          ) : null}
        </>
      )}
    </PropertySection>
  );
}

/** Where grid items sit: their cell, span and alignment in it. */
export function GridItemSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const first = nodes[0];
  if (!first) return null;
  const cellOf = (node: NodeRecord): GridCell | null =>
    gridGeometry(editor.doc, node.parent)?.cells.get(node.id) ?? null;
  const cells = nodes.map(cellOf);
  const shared = <K extends keyof GridCell>(key: K) => {
    const values = new Set(cells.map((c) => (c ? c[key] : null)));
    const [only] = values;
    return values.size === 1 && only !== null && only !== undefined
      ? only + (key === "column" || key === "row" ? 1 : 0)
      : null;
  };
  const placed = nodes.some((n) => getProp(n.props, "gridArea") !== null);

  /** Sets one part of each item's area, starting from where it sits now. */
  const setArea = (
    key: "column" | "row" | "columnSpan" | "rowSpan",
    value: number,
    label: string,
  ) => {
    editor.beginGesture(label);
    nodes.forEach((node, i) => {
      const cell = cells[i];
      if (!cell) return;
      const area = {
        column: cell.column + 1,
        row: cell.row + 1,
        columnSpan: cell.columnSpan,
        rowSpan: cell.rowSpan,
        [key]: Math.max(1, Math.min(256, Math.round(value))),
      };
      editor.setProp([node.id], "gridArea", area);
    });
    editor.endGesture();
  };

  const title =
    nodes.length === 1 ? `${getProp(first.props, "name") || "Layer"} · grid item` : "Grid items";
  return (
    <PropertySection
      title={title}
      actions={
        placed ? (
          <IconButton
            icon="restart"
            label="Place automatically"
            onClick={() => editor.setProp(ids, "gridArea", null, "Place automatically")}
          />
        ) : null
      }
    >
      <PropertyRow>
        <NumberField
          label="Col"
          ariaLabel="Column"
          value={shared("column")}
          placeholder="Mixed"
          min={1}
          onChange={(value) => setArea("column", value, "Grid column")}
        />
        <NumberField
          label="⇥"
          ariaLabel="Column span"
          value={shared("columnSpan")}
          placeholder="Mixed"
          min={1}
          onChange={(value) => setArea("columnSpan", value, "Column span")}
        />
      </PropertyRow>
      <PropertyRow>
        <NumberField
          label="Row"
          ariaLabel="Row"
          value={shared("row")}
          placeholder="Mixed"
          min={1}
          onChange={(value) => setArea("row", value, "Grid row")}
        />
        <NumberField
          label="⇥"
          ariaLabel="Row span"
          value={shared("rowSpan")}
          placeholder="Mixed"
          min={1}
          onChange={(value) => setArea("rowSpan", value, "Row span")}
        />
      </PropertyRow>
      <PropertyRow>
        <Select
          label="Justify self"
          value={common(nodes, "justifySelf")}
          options={SELF.map((o) => ({ ...o, label: `Across: ${o.label}` }))}
          onChange={(value) => editor.setProp(ids, "justifySelf", value, "Justify self")}
        />
        <Select
          label="Align self"
          value={common(nodes, "alignSelf")}
          options={SELF.map((o) => ({ ...o, label: `Down: ${o.label}` }))}
          onChange={(value) => editor.setProp(ids, "alignSelf", value, "Align self")}
        />
      </PropertyRow>
      {placed ? null : (
        <p className="inspector__mixed">Placed automatically, in the next free cell.</p>
      )}
    </PropertySection>
  );
}
