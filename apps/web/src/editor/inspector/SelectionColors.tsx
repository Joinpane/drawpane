/**
 * Selection colors: every color inside the selection, with how many layers
 * use it. Changing one recolors all of them in one undo step.
 */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { ColorPicker, Popover, PropertySection } from "@drawpane/ui";
import { useRef, useState } from "react";
import { HexField } from "./PaintSection";
import { swatchCss } from "./paint";
import { replaceColorOps, selectionColors } from "./selection-colors";

const COLLAPSED = 8;

export function SelectionColors({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const colors = selectionColors(editor.doc, ids);
  const [all, setAll] = useState(false);
  // Only worth showing when there's more than one layer's worth of color to manage.
  const containers = nodes.some((n) => editor.doc.childIds(n.id).length > 0);
  if (colors.length < 2 && !containers) return null;
  if (colors.length === 0) return null;
  const replace = (from: string, to: string, label = "Selection color") => {
    const ops = replaceColorOps(editor.doc, ids, from, to);
    if (ops.length > 0) editor.commit(ops, label);
  };
  const shown = all ? colors : colors.slice(0, COLLAPSED);
  return (
    <PropertySection title={`Selection colors · ${colors.length}`}>
      <ul className="selection-colors">
        {shown.map((c, i) => (
          <SelectionColorRow
            key={i}
            editor={editor}
            color={c.color}
            layers={c.layers}
            onReplace={replace}
          />
        ))}
      </ul>
      {colors.length > COLLAPSED ? (
        <button type="button" className="inspector__more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${colors.length}`}
        </button>
      ) : null}
    </PropertySection>
  );
}

function SelectionColorRow({
  editor,
  color,
  layers,
  onReplace,
}: {
  editor: Editor;
  color: string;
  layers: number;
  onReplace: (from: string, to: string, label?: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <li className="selection-colors__row">
      <button
        ref={ref}
        type="button"
        className="paint-swatch"
        aria-label={`Change ${color.slice(1).toUpperCase()} everywhere in the selection`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ background: swatchCss({ type: "solid", color }) }}
        onClick={() => setOpen((o) => !o)}
      />
      <HexField label="Selection color" color={color} onChange={(to) => onReplace(color, to)} />
      <span className="selection-colors__count">
        {layers} {layers === 1 ? "layer" : "layers"}
      </span>
      {open && ref.current ? (
        <Popover
          anchor={ref.current}
          label="Selection color"
          className="paint-picker dp-root"
          onClose={() => setOpen(false)}
        >
          <div className="paint-picker__body">
            <ColorPicker
              label="Selection"
              value={color}
              onChange={(to) => onReplace(color, to)}
              onChangeStart={() => editor.beginGesture("Selection color")}
              onChangeEnd={() => editor.endGesture()}
            />
          </div>
        </Popover>
      ) : null}
    </li>
  );
}
