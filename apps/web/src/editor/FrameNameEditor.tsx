/**
 * Renaming a frame on the canvas: double-click its name label and type, like
 * Figma and Penpot. The input sits exactly where the label was drawn, in the
 * label's type, and grows with the name. Enter or clicking away keeps it;
 * Esc goes back.
 */
import { frameLabels, LABEL_FONT } from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { useLayoutEffect, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";

export function FrameNameEditor() {
  const editor = useEditor();
  useDocVersion();
  const id = useEditorState((s) => s.renamingFrame);
  // Follow the label as the camera moves.
  useEditorState((s) => s.camera);
  const node = id ? editor.doc.get(id) : undefined;
  if (!id || !node) return null;
  const label = frameLabels(editor).find((l) => l.id === id);
  if (!label) return null;
  return (
    <NameInput
      key={id}
      initial={getProp(node.props, "name") || "Frame"}
      x={label.textX}
      y={label.box.y}
      onDone={(name) => {
        editor.state.set({ renamingFrame: null });
        const trimmed = name?.trim();
        if (trimmed && trimmed !== getProp(node.props, "name"))
          editor.setProp([id], "name", trimmed.slice(0, 200), "Rename");
      }}
    />
  );
}

function NameInput({
  initial,
  x,
  y,
  onDone,
}: {
  initial: string;
  x: number;
  y: number;
  /** The new name, or null to keep the old one. */
  onDone: (name: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  // Grow with the text: measured in the label's own font.
  const width = Math.min(360, Math.max(48, measure(value) + 14));
  return (
    <input
      ref={ref}
      className="frame-name-input"
      aria-label="Frame name"
      value={value}
      spellCheck={false}
      autoComplete="off"
      style={{ left: x - 5, top: y - 2, width }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Typing a name never reaches the canvas's shortcuts.
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}

let context: CanvasRenderingContext2D | null = null;
function measure(text: string): number {
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return text.length * 6;
  context.font = LABEL_FONT;
  return context.measureText(text).width;
}
