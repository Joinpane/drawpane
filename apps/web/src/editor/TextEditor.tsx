import {
  caretBox,
  indexAtPoint,
  indexOnLine,
  layoutTextNode,
  lineOf,
  selectionBoxes,
  type TextLayout,
} from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Button } from "@drawpane/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { useUi } from "./ui-state";

/**
 * Edits a text layer in place. The canvas draws the text itself (rich text
 * mixes fonts, sizes and colours, which no textarea can show), so typing
 * goes through a textarea whose glyphs are invisible: the browser's input
 * stack still does IME, spellcheck, the clipboard and word-wise editing.
 * The caret, the selection, clicking, dragging and moving between lines all
 * come from the canvas's own layout, so they line up with what's drawn.
 * Each change commits live, so collaborators watch the text appear.
 */
/** Presses this close in time and place count as one double or triple click. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;

export function TextEditor({ nodeId }: { nodeId: string }) {
  const editor = useEditor();
  useDocVersion();
  const camera = useEditorState((s) => s.camera);
  const selection = useEditorState((s) => s.textSelection);
  const workspaceMode = useUi(editor, (ui) => ui.workspaceMode);
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const node = editor.doc.get(nodeId);
  const [value, setValue] = useState(() => (node ? getProp(node.props, "characters") : ""));
  const initialChars = useRef(node ? getProp(node.props, "characters") : "");
  const dirty = useRef(false);
  // Where ↑ and ↓ aim, kept across presses so a short line doesn't pull the caret left.
  const goal = useRef<number | null>(null);
  const dragging = useRef<number | null>(null);
  // Double and triple clicks, counted here: pointer events don't carry a click count everywhere.
  const lastPress = useRef<{ x: number; y: number; at: number; count: number } | null>(null);
  // The caret shows while typing; styling the selection from the inspector keeps it selected.
  const [focused, setFocused] = useState(true);

  // Where the last pointer press landed, so a blur can tell a click on the
  // inspector (keep editing, to style the selection) from one elsewhere.
  const pressed = useRef<EventTarget | null>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      pressed.current = e.target;
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);

  const report = () => {
    const t = ref.current;
    if (t) editor.setTextSelection(t.selectionStart, t.selectionEnd);
  };

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    report();
  }, []);

  // Keep in step with remote edits when we aren't the one typing.
  useEffect(() => {
    const remote = node ? getProp(node.props, "characters") : "";
    if (document.activeElement !== ref.current) setValue(remote);
  }, [node]);

  if (node?.type !== "text") return null;
  // All of it, past any truncation, the way the canvas draws it while editing.
  const layout = layoutTextNode(node, editor.measurer, { whole: true });
  const m = editor.scene.worldMatrix(nodeId);
  const props = node.props;
  const width = getProp(props, "width");
  const height = getProp(props, "height");
  const auto = getProp(props, "textAutoResize");
  // One screen pixel in the text box's units, for a crisp caret at any zoom.
  const pixel = 1 / (camera.zoom * Math.hypot(m[0], m[1]) || 1);

  /** The selection's moving end: where the caret is drawn and keys move from. */
  const focusIndex = (t: HTMLTextAreaElement) =>
    t.selectionDirection === "backward" ? t.selectionStart : t.selectionEnd;
  const anchorIndex = (t: HTMLTextAreaElement) =>
    t.selectionDirection === "backward" ? t.selectionEnd : t.selectionStart;
  const select = (anchor: number, focus: number) => {
    const t = ref.current;
    if (!t) return;
    if (focus < anchor) t.setSelectionRange(focus, anchor, "backward");
    else t.setSelectionRange(anchor, focus, "forward");
    report();
  };

  /** The caret index under a pointer event. */
  const indexAt = (e: React.PointerEvent): number => {
    const host = box.current?.offsetParent?.getBoundingClientRect();
    const screen = { x: e.clientX - (host?.left ?? 0), y: e.clientY - (host?.top ?? 0) };
    const local = editor.scene.toLocal(nodeId, camera.toPage(screen));
    return indexAtPoint(node, layout, editor.measurer, local.x, local.y);
  };

  const style: React.CSSProperties = {
    transform: `matrix(${m[0] * camera.zoom}, ${m[1] * camera.zoom}, ${m[2] * camera.zoom}, ${m[3] * camera.zoom}, ${m[4] * camera.zoom + camera.x}, ${m[5] * camera.zoom + camera.y})`,
    width: Math.max(width, 4),
    height: Math.max(height, layout.height),
  };
  const text = value === getProp(props, "characters") ? value : getProp(props, "characters");
  const start = Math.min(selection?.start ?? 0, text.length);
  const end = Math.min(selection?.end ?? 0, text.length);
  const caretAt = ref.current ? Math.min(focusIndex(ref.current), text.length) : end;
  const caret = focused && start === end ? caretBox(node, layout, editor.measurer, caretAt) : null;

  const cancelEdit = () => {
    if (dirty.current) {
      if (initialChars.current.trim() === "") {
        editor.updateText(nodeId, "");
        editor.endTextEdit();
      } else {
        editor.endTextEdit();
        editor.undo();
      }
      return;
    }
    editor.endTextEdit();
  };

  return (
    <>
      <div
        ref={box}
        className="canvas__text-editing"
        style={style}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // Keep focus in the textarea; we place the caret ourselves.
          e.preventDefault();
          ref.current?.focus();
          goal.current = null;
          const t = ref.current;
          if (!t) return;
          const at = indexAt(e);
          const prev = lastPress.current;
          const count =
            prev &&
            e.timeStamp - prev.at < MULTI_CLICK_MS &&
            Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < MULTI_CLICK_PX
              ? prev.count + 1
              : 1;
          lastPress.current = { x: e.clientX, y: e.clientY, at: e.timeStamp, count };
          if (count === 2) {
            const [a, b] = wordAt(text, at);
            select(a, b);
            return;
          }
          if (count >= 3) {
            const a = text.lastIndexOf("\n", at - 1) + 1;
            const nl = text.indexOf("\n", at);
            select(a, nl === -1 ? text.length : nl);
            return;
          }
          const anchor = e.shiftKey ? anchorIndex(t) : at;
          select(anchor, at);
          dragging.current = anchor;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragging.current === null) return;
          select(dragging.current, indexAt(e));
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
      >
        {selectionBoxes(node, layout, editor.measurer, start, end).map((r) => (
          <div
            key={`${r.y}:${r.x}`}
            className="canvas__text-selection"
            style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
          />
        ))}
        {caret ? (
          <div
            // A new key restarts the blink, so the caret shows right after it moves.
            key={`${caretAt}:${caret.x}:${caret.y}`}
            className="canvas__caret"
            style={{
              left: caret.x - pixel / 2,
              top: caret.y,
              width: pixel * 1.5,
              height: caret.height,
            }}
          />
        ) : null}
        <textarea
          ref={ref}
          className="canvas__text-editor"
          style={{
            // Same box and base type as the layer, so the IME's window sits near the caret.
            width: auto === "width" ? Math.max(width, 4) + 8 : width,
            height: Math.max(height, layout.lineHeight),
            font: layout.font,
            lineHeight: `${layout.lineHeight}px`,
            letterSpacing: `${layout.letterSpacing}px`,
            textAlign: getProp(props, "textAlign"),
            whiteSpace: auto === "width" ? "pre" : "pre-wrap",
          }}
          value={value}
          aria-label="Text"
          spellCheck
          onChange={(e) => {
            const t = e.target;
            dirty.current = true;
            setValue(t.value);
            editor.updateText(nodeId, t.value, t.selectionEnd);
            // "- " or "1. " at a paragraph's start: a list item (decision 0017).
            report();
            const caret = editor.autoList(nodeId);
            if (caret !== null) {
              const next = getProp(editor.doc.get(nodeId)?.props ?? {}, "characters");
              t.value = next;
              t.setSelectionRange(caret, caret);
              setValue(next);
              report();
            }
          }}
          onSelect={report}
          onKeyDown={(e) => {
            e.stopPropagation();
            const t = e.currentTarget;
            const mod = e.metaKey || e.ctrlKey;
            // ⌘B, ⌘I and ⌘U style the selected characters (or what's typed next).
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
            // Lists (decision 0017): ⌘⇧8 bullets, ⌘⇧7 numbers, as in Figma.
            if (mod && e.shiftKey && !e.altKey && (e.code === "Digit8" || e.code === "Digit7")) {
              e.preventDefault();
              editor.toggleList(e.code === "Digit8" ? "bullet" : "number");
              return;
            }
            // In a list, Tab nests an item and ⇧Tab takes it out a level.
            if (e.key === "Tab" && !mod && !e.altKey && editor.nestList(e.shiftKey ? -1 : 1)) {
              e.preventDefault();
              return;
            }
            if (
              (e.key === "Enter" || e.key === "Backspace") &&
              !mod &&
              !e.shiftKey &&
              !e.altKey &&
              t.selectionStart === t.selectionEnd
            ) {
              const { listType } = editor.listState();
              const at = t.selectionStart;
              const start = t.value.lastIndexOf("\n", at - 1) + 1;
              const nl = t.value.indexOf("\n", at);
              const empty = start === at && (nl === -1 ? t.value.length : nl) === at;
              // Enter on an empty item ends the list; Backspace at an item's start takes it out
              // of the list before it joins the line above, as text editors do.
              if (
                (listType === "bullet" || listType === "number") &&
                (e.key === "Enter" ? empty : start === at)
              ) {
                e.preventDefault();
                editor.toggleList(listType);
                return;
              }
            }
            if (e.key === "Escape" || (e.key === "Enter" && mod)) {
              e.preventDefault();
              editor.endTextEdit();
              return;
            }
            const move = lineMove(e, node, layout, editor, t, goal);
            if (move !== null) {
              e.preventDefault();
              select(e.shiftKey ? anchorIndex(t) : move, move);
              return;
            }
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") goal.current = null;
          }}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            setFocused(false);
            // Into the inspector, its popovers or the touch Done/Cancel bar: keep editing.
            if (keepsEditing(e.relatedTarget ?? pressed.current)) return;
            // On touch tablets, dismissing the virtual keyboard can blur without leaving the edit;
            // keep editing active until the user taps the canvas or explicit Done/Cancel.
            if (workspaceMode === "tablet" && !e.relatedTarget && !pressed.current) return;
            editor.endTextEdit();
          }}
        />
      </div>
      {workspaceMode === "tablet" ? (
        <div
          className="text-edit-bar pane"
          role="toolbar"
          aria-label="Text editing actions"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          <span className="text-edit-bar__label">Editing text</span>
          <Button size="md" variant="ghost" onClick={cancelEdit}>
            Cancel
          </Button>
          <Button size="md" variant="primary" onClick={() => editor.endTextEdit()}>
            Done
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Places focus can go while the text stays in edit mode: the inspector, its popovers and the mobile bar. */
const KEEP_EDITING = ".pane--right, .dp-popover, .text-edit-bar";

function keepsEditing(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEEP_EDITING) !== null;
}

/**
 * Where ↑, ↓, Home, End (and ⌘← ⌘→ on a Mac) move the caret, by the
 * canvas's lines rather than the hidden textarea's; null for other keys.
 */
function lineMove(
  e: React.KeyboardEvent,
  node: NodeRecord,
  layout: TextLayout,
  editor: ReturnType<typeof useEditor>,
  t: HTMLTextAreaElement,
  goal: { current: number | null },
): number | null {
  const focus = t.selectionDirection === "backward" ? t.selectionStart : t.selectionEnd;
  const k = lineOf(layout, focus);
  const line = layout.lines[k];
  if (!line) return null;
  const mac = e.metaKey && !e.ctrlKey;
  if (e.key === "Home" || (mac && e.key === "ArrowLeft")) return line.start;
  if (e.key === "End" || (mac && e.key === "ArrowRight")) return line.end;
  if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.metaKey || e.ctrlKey || e.altKey)
    return null;
  const x = goal.current ?? caretBox(node, layout, editor.measurer, focus).x;
  goal.current = x;
  const next = e.key === "ArrowUp" ? k - 1 : k + 1;
  if (next < 0) return 0;
  if (next >= layout.lines.length) return getProp(node.props, "characters").length;
  return indexOnLine(node, layout, editor.measurer, next, x);
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** The word (or run of spaces or punctuation) around `index`, for a double-click. */
export function wordAt(text: string, index: number): [number, number] {
  if (text.length === 0) return [0, 0];
  const at = Math.min(index, text.length - 1);
  if (segmenter) {
    for (const seg of segmenter.segment(text)) {
      const endOf = seg.index + seg.segment.length;
      if (at >= seg.index && at < endOf) {
        // A double-click just past a word's end still takes the word.
        if (!seg.isWordLike && index === seg.index && index > 0) return wordAt(text, index - 1);
        return [seg.index, endOf];
      }
    }
  }
  const word = /[\p{L}\p{N}_]/u;
  const kind = (c: string) => (word.test(c) ? 0 : /\s/.test(c) ? 1 : 2);
  const k = kind(text[at] as string);
  let a = at;
  let b = at + 1;
  while (a > 0 && kind(text[a - 1] as string) === k) a--;
  while (b < text.length && kind(text[b] as string) === k) b++;
  return [a, b];
}
