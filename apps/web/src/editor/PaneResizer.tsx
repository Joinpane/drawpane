/**
 * The grip on a side panel's inner edge: drag it to make the panel wider or
 * narrower, double-click it for the default width. It's a focusable
 * separator too: ← and → change the width (⇧ for bigger steps), Home and End
 * go to the narrowest and widest, Enter to the default.
 */
import { clampPane, PANE, type PaneSide, setPanelLayout } from "./panel-layout";
import { Splitter } from "./Splitter";

export function PaneResizer({
  side,
  label,
  width,
  viewportWidth,
  other,
}: {
  side: PaneSide;
  /** What the panel is, for "Resize the layers panel". */
  label: string;
  /** The panel's width as shown. */
  width: number;
  viewportWidth: number;
  /** The other panel's width while it's open, 0 when it isn't: the canvas keeps room between them. */
  other: number;
}) {
  const clamp = (w: number) => clampPane(w, viewportWidth, other);
  return (
    <Splitter
      axis="x"
      // The right panel grows leftwards: dragging left makes it wider.
      grows={side === "left" ? 1 : -1}
      value={width}
      min={PANE.min}
      max={clamp(PANE.max)}
      reset={PANE.default}
      onResize={(next, remember) => setPanelLayout({ [side]: clamp(next) }, { remember })}
      label={`Resize the ${label}`}
      valueText={`${width} pixels wide`}
      title="Drag to resize · double-click for the default width"
      className={`pane-resizer pane-resizer--${side}`}
    />
  );
}
