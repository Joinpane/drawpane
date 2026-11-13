/**
 * Constraints: how a layer follows its frame when the frame resizes. A pin
 * diagram (click an edge to pin to it, Shift-click a second edge to pin both,
 * click the middle line to centre) and a select per axis.
 */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { PropertySection } from "@drawpane/ui";
import { common, Select } from "./fields";

type Constraint = "start" | "end" | "center" | "stretch" | "scale";

const H_OPTIONS = [
  { value: "start", label: "Left" },
  { value: "end", label: "Right" },
  { value: "stretch", label: "Left and right" },
  { value: "center", label: "Center" },
  { value: "scale", label: "Scale" },
] as const;

const V_OPTIONS = [
  { value: "start", label: "Top" },
  { value: "end", label: "Bottom" },
  { value: "stretch", label: "Top and bottom" },
  { value: "center", label: "Center" },
  { value: "scale", label: "Scale" },
] as const;

/** Clicking an edge: pin to it, or with Shift add it to the other edge (stretch). */
function pinEdge(current: Constraint | null, edge: "start" | "end", shift: boolean): Constraint {
  if (shift) {
    if (current === "stretch") return edge === "start" ? "end" : "start";
    if (current === (edge === "start" ? "end" : "start")) return "stretch";
  }
  return edge;
}

export function ConstraintsSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const h = common(nodes, "constraintH");
  const v = common(nodes, "constraintV");
  const setH = (value: Constraint) =>
    editor.setProp(ids, "constraintH", value === "start" ? null : value, "Horizontal constraint");
  const setV = (value: Constraint) =>
    editor.setProp(ids, "constraintV", value === "start" ? null : value, "Vertical constraint");
  const on = (axis: Constraint | null, edge: "start" | "end" | "center") =>
    axis === edge || axis === "scale" || (axis === "stretch" && edge !== "center");

  const bar = (
    side: "left" | "right" | "top" | "bottom" | "center-h" | "center-v",
    label: string,
    pressed: boolean,
    click: (shift: boolean) => void,
  ) => (
    <button
      type="button"
      className="constraints__pin"
      data-side={side}
      aria-label={label}
      aria-pressed={pressed}
      onClick={(e) => click(e.shiftKey)}
    />
  );

  return (
    <PropertySection title="Constraints">
      <div className="constraints">
        <fieldset className="constraints__diagram" aria-label="Pin to frame edges">
          <span className="constraints__box" aria-hidden="true" />
          {bar("top", "Pin to top", on(v, "start"), (shift) => setV(pinEdge(v, "start", shift)))}
          {bar("bottom", "Pin to bottom", on(v, "end"), (shift) => setV(pinEdge(v, "end", shift)))}
          {bar("left", "Pin to left", on(h, "start"), (shift) => setH(pinEdge(h, "start", shift)))}
          {bar("right", "Pin to right", on(h, "end"), (shift) => setH(pinEdge(h, "end", shift)))}
          {bar("center-v", "Center horizontally", h === "center", () => setH("center"))}
          {bar("center-h", "Center vertically", v === "center", () => setV("center"))}
        </fieldset>
        <div className="constraints__selects">
          <Select label="Horizontal constraint" value={h} options={H_OPTIONS} onChange={setH} />
          <Select label="Vertical constraint" value={v} options={V_OPTIONS} onChange={setV} />
        </div>
      </div>
    </PropertySection>
  );
}
