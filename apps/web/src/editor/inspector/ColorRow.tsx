/**
 * A color with alpha in one row: a swatch that opens the full picker, the
 * hex, and the opacity. For colors that are a single `#rrggbbaa` value
 * (shadows, layout grids), not paints with their own opacity.
 */
import type { Editor } from "@drawpane/editor";
import { ColorPicker, NumberField, Popover, toHex } from "@drawpane/ui";
import { useRef, useState } from "react";
import { HexField } from "./PaintSection";
import { rgbaOf, swatchCss } from "./paint";

export function ColorRow({
  editor,
  label,
  color,
  onChange,
}: {
  editor: Editor;
  /** "Shadow", "Grid": names the controls and the undo steps. */
  label: string;
  color: string;
  onChange: (color: string, undoLabel: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const alpha = Math.round(rgbaOf(color).a * 100);
  return (
    <div className="paint-row paint-row--color">
      <button
        ref={ref}
        type="button"
        className="paint-swatch"
        aria-label={`Edit ${label.toLowerCase()} color`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ background: swatchCss({ type: "solid", color }) }}
        onClick={() => setOpen((o) => !o)}
      />
      <HexField label={label} color={color} onChange={(c) => onChange(c, `${label} color`)} />
      <NumberField
        ariaLabel={`${label} opacity`}
        unit="%"
        min={0}
        max={100}
        precision={0}
        value={alpha}
        onChange={(v) => {
          const next = toHex({ ...rgbaOf(color), a: Math.min(1, Math.max(0, v / 100)) });
          if (next !== color) onChange(next, `${label} opacity`);
        }}
        onScrubStart={() => editor.beginGesture(`${label} opacity`)}
        onScrubEnd={() => editor.endGesture()}
      />
      {open && ref.current ? (
        <Popover
          anchor={ref.current}
          label={`${label} color`}
          className="paint-picker dp-root"
          onClose={() => setOpen(false)}
        >
          <div className="paint-picker__body">
            <ColorPicker
              label={label}
              value={color}
              onChange={(c) => onChange(c, `${label} color`)}
              onChangeStart={() => editor.beginGesture(`${label} color`)}
              onChangeEnd={() => editor.endGesture()}
            />
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
