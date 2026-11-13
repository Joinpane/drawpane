import { Kbd } from "@drawpane/ui";
import { isMac } from "../app/format";
import { useEditorState } from "./hooks";
import "./vector.css";

/** The key hints strip at the bottom of the canvas while drawing or editing a path. */
export function VectorHints() {
  const pen = useEditorState((s) => s.tool === "pen");
  const editing = useEditorState((s) => s.vectorEdit !== null);
  if (!pen && !editing) return null;
  const mac = isMac();
  const alt = mac ? "⌥" : "Alt";
  const shift = mac ? "⇧" : "Shift";
  const hints: Array<[string, string]> = pen
    ? [
        [shift, "snap to 45°"],
        [mac ? "⌫" : "Backspace", "remove point"],
        [mac ? "↵" : "Enter", "done"],
      ]
    : [
        [alt, "break handle"],
        [shift, "snap to 45°"],
        [mac ? "↵" : "Enter", "done"],
      ];
  return (
    <div className="vector-hints pane" role="note" aria-label="Path shortcuts">
      {hints.map(([key, label]) => (
        <span key={label} className="vector-hints__item">
          <Kbd>{key}</Kbd> {label}
        </span>
      ))}
    </div>
  );
}
