/**
 * Frame presets: with the frame tool on, the inspector lists common screen,
 * paper and social sizes. Clicking one adds a frame of that size in view;
 * drawing on the canvas still works as before.
 */
import type { Editor } from "@drawpane/editor";
import { FRAME_PRESETS } from "@drawpane/editor";
import { Icon } from "@drawpane/ui";
import { useState } from "react";

const OPEN_KEY = "drawpane:frame-presets-open";

function storedOpen(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // Unavailable or malformed: start with the common groups open.
  }
  return new Set(["Phone", "Tablet", "Desktop"]);
}

export function FramePresets({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(storedOpen);
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered; still works.
      }
      return next;
    });

  return (
    <div className="inspector frame-presets">
      <h2 className="inspector__title">Frame</h2>
      <p className="inspector__hint">Drag on the canvas to draw a frame, or start from a size.</p>
      {FRAME_PRESETS.map((group) => {
        const expanded = open.has(group.name);
        return (
          <section key={group.name} className="frame-presets__group">
            <button
              type="button"
              className="frame-presets__heading"
              aria-expanded={expanded}
              onClick={() => toggle(group.name)}
            >
              <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
              {group.name}
            </button>
            {expanded ? (
              <ul className="frame-presets__list">
                {group.presets.map((preset) => (
                  <li key={preset.id}>
                    <button
                      type="button"
                      className="frame-presets__item"
                      disabled={!editor.canEdit}
                      onClick={() => editor.insertFramePreset(preset)}
                    >
                      <span className="frame-presets__name">{preset.name}</span>
                      <span className="frame-presets__size">
                        {preset.width}×{preset.height}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
