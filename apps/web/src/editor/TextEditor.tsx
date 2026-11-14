import { fontString, letterSpacingPx, lineHeightPx } from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";

/**
 * Edits a text layer in place with a transparent textarea laid exactly over
 * it, so typing uses the browser's input stack (IME, spellcheck, selection).
 * Each change commits live, so collaborators watch the text appear.
 */
export function TextEditor({ nodeId }: { nodeId: string }) {
  const editor = useEditor();
  useDocVersion();
  const camera = useEditorState((s) => s.camera);
  const ref = useRef<HTMLTextAreaElement>(null);
  const node = editor.doc.get(nodeId);
  const [value, setValue] = useState(() => (node ? getProp(node.props, "characters") : ""));

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // Keep in step with remote edits when we aren't the one typing.
  useEffect(() => {
    const remote = node ? getProp(node.props, "characters") : "";
    if (document.activeElement !== ref.current) setValue(remote);
  }, [node]);

  if (!node) return null;
  const m = editor.scene.worldMatrix(nodeId);
  const props = node.props;
  const width = getProp(props, "width");
  const height = getProp(props, "height");
  const auto = getProp(props, "textAutoResize");
  const fills = getProp(props, "fills");
  const color = fills[0]?.type === "solid" ? fills[0].color : "#000000";

  const style: React.CSSProperties = {
    left: 0,
    top: 0,
    transformOrigin: "0 0",
    transform: `matrix(${m[0] * camera.zoom}, ${m[1] * camera.zoom}, ${m[2] * camera.zoom}, ${m[3] * camera.zoom}, ${m[4] * camera.zoom + camera.x}, ${m[5] * camera.zoom + camera.y})`,
    width: auto === "width" ? Math.max(width, 4) + 8 : width,
    height: Math.max(height, lineHeightPx(props)),
    font: fontString(props),
    lineHeight: `${lineHeightPx(props)}px`,
    letterSpacing: `${letterSpacingPx(props)}px`,
    textAlign: getProp(props, "textAlign"),
    color,
    caretColor: "var(--signal)",
    whiteSpace: auto === "width" ? "pre" : "pre-wrap",
  };

  return (
    <textarea
      ref={ref}
      className="canvas__text-editor"
      style={style}
      value={value}
      aria-label="Text"
      spellCheck
      onChange={(e) => {
        setValue(e.target.value);
        editor.updateText(nodeId, e.target.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        // ⌘B, ⌘I and ⌘U style the layer while you type, like everywhere else.
        const mod = e.metaKey || e.ctrlKey;
        const toggle =
          mod && !e.altKey && !e.shiftKey
            ? ({ b: "bold", i: "italic", u: "underline" } as const)[
                e.key.toLowerCase() as "b" | "i" | "u"
              ]
            : undefined;
        if (toggle) {
          e.preventDefault();
          editor.toggleTextStyle(toggle);
          return;
        }
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          editor.endTextEdit();
        }
      }}
      onBlur={() => editor.endTextEdit()}
    />
  );
}
