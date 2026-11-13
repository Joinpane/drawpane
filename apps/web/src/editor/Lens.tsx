import { getProp } from "@drawpane/model";
import { type IconName, NumberField, SelectionLens } from "@drawpane/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";

const KIND: Record<string, { label: string; icon: IconName }> = {
  frame: { label: "Frame", icon: "board" },
  group: { label: "Group", icon: "group" },
  rect: { label: "Rectangle", icon: "rectangle" },
  ellipse: { label: "Ellipse", icon: "ellipse" },
  line: { label: "Line", icon: "minus" },
  path: { label: "Vector", icon: "pen" },
  text: { label: "Text", icon: "text" },
};

/**
 * The Selection Lens: a compact strip anchored under the selection with the
 * four or five controls that matter for that layer type, so your eyes stay on
 * the work. The full inspector is one keypress away.
 */
export function Lens({ onOpenInspector }: { onOpenInspector: () => void }) {
  const editor = useEditor();
  useDocVersion();
  const selection = useEditorState((s) => s.selection);
  const camera = useEditorState((s) => s.camera);
  const viewport = useEditorState((s) => s.viewport);
  const gesture = useEditorState((s) => s.gesture);
  // Vector edit has its own marks on the canvas; keep the path clear.
  const vectorEdit = useEditorState((s) => s.vectorEdit !== null);
  const editing = useEditorState((s) => s.editingText);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const tool = useEditorState((s) => s.tool);
  const scrubbing = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  // Appear once the selection has settled, so a quick follow-up click (like a
  // Shift-click on the layer just below) lands on the canvas, not the Lens.
  const [settled, setSettled] = useState(false);
  const [shift, setShift] = useState(false);
  const selectionKey = selection.join(",");
  useEffect(() => {
    setSettled(false);
    if (!selectionKey) return;
    const t = setTimeout(() => setSettled(true), 350);
    return () => clearTimeout(t);
  }, [selectionKey]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => e.key === "Shift" && setShift(true);
    const up = (e: KeyboardEvent) => e.key === "Shift" && setShift(false);
    const blur = () => setShift(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  // Keep the Lens between the side panes: shift it horizontally if it would overlap one.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = document.querySelector(".pane--left")?.getBoundingClientRect().right ?? 0;
    const right =
      document.querySelector(".pane--right")?.getBoundingClientRect().left ?? window.innerWidth;
    const margin = 8;
    let shiftBy = 0;
    if (rect.left - offset < left + margin) shiftBy = left + margin - (rect.left - offset);
    else if (rect.right - offset > right - margin) shiftBy = right - margin - (rect.right - offset);
    if (Math.abs(shiftBy - offset) > 0.5) setOffset(shiftBy);
  });
  // Hide during canvas gestures, but not while scrubbing one of our own fields:
  // unmounting mid-scrub would lose the scrub's end and leave the gesture open.
  const hidden =
    selection.length !== 1 ||
    (gesture && !scrubbing.current) ||
    (!settled && !scrubbing.current) ||
    (shift && !scrubbing.current) ||
    editing !== null ||
    vectorEdit ||
    !canEdit ||
    tool !== "select";
  if (hidden) return null;
  const node = editor.doc.get(selection[0] as string);
  const bounds = node ? editor.scene.bounds(node.id) : null;
  if (!node || !bounds || node.type === "group") return null;

  const bottom = camera.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });
  const top = camera.toScreen({ x: bounds.x, y: bounds.y });
  // Below the selection (clear of the size pill); flip above when it would leave the screen.
  const below = bottom.y + 40 + 44 < viewport.height;
  const y = below ? bottom.y + 36 : top.y - 52;
  // Keep clear of the top bar (file title, tools, share) at 12–52px.
  if (y < 64 || bottom.x < 0 || bottom.x > viewport.width) return null;

  const kind = KIND[node.type] ?? { label: "Layer", icon: "rectangle" as IconName };
  const label =
    node.type === "frame" && getProp(node.props, "layoutMode") !== "none"
      ? `${kind.label} · Auto layout`
      : kind.label;

  const field = (
    key: string,
    value: number | null,
    aria: string,
    look: { label: string } | { icon: IconName },
    apply: (v: number) => void,
  ) => (
    <NumberField
      key={key}
      {...look}
      ariaLabel={aria}
      value={value === null ? null : Math.round(value * 100) / 100}
      placeholder="Mixed"
      onChange={apply}
      onScrubStart={() => {
        scrubbing.current = true;
        editor.beginGesture(aria);
      }}
      onScrubEnd={() => {
        scrubbing.current = false;
        editor.endGesture();
      }}
    />
  );
  const prop = (
    name: "width" | "height" | "gap" | "cornerRadius" | "fontSize",
    aria: string,
    look: { label: string } | { icon: IconName },
  ) =>
    field(name, getProp(node.props, name), aria, look, (v) =>
      editor.setProp([node.id], name, v, aria),
    );

  const p = node.props;
  const paddings = [
    getProp(p, "paddingTop"),
    getProp(p, "paddingRight"),
    getProp(p, "paddingBottom"),
    getProp(p, "paddingLeft"),
  ];
  const uniformPadding = paddings.every((v) => v === paddings[0]) ? (paddings[0] ?? 0) : null;
  const isLayout = node.type === "frame" && getProp(p, "layoutMode") !== "none";

  const controls =
    node.type === "text"
      ? [prop("fontSize", "Font size", { label: "Aa" }), prop("width", "Width", { label: "W" })]
      : isLayout
        ? [
            prop("width", "Width", { label: "W" }),
            prop("height", "Height", { label: "H" }),
            prop("gap", "Gap", {
              icon: getProp(p, "layoutMode") === "row" ? "gap-horizontal" : "gap-vertical",
            }),
            field("padding", uniformPadding, "Padding", { icon: "padding" }, (v) => {
              editor.beginGesture("Padding");
              for (const side of [
                "paddingTop",
                "paddingRight",
                "paddingBottom",
                "paddingLeft",
              ] as const) {
                editor.setProp([node.id], side, v, "Padding");
              }
              editor.endGesture();
            }),
          ]
        : [
            prop("width", "Width", { label: "W" }),
            prop("height", "Height", { label: "H" }),
            ...(node.type === "frame" || node.type === "rect"
              ? [prop("cornerRadius", "Corner radius", { icon: "radius" })]
              : []),
          ];

  return (
    <div ref={ref} className="lens-anchor" style={{ left: bottom.x + offset, top: y }}>
      <SelectionLens
        kind={label}
        kindIcon={kind.icon}
        onOpenInspector={onOpenInspector}
        inspectorShortcut="⌥⌘I"
      >
        {controls}
      </SelectionLens>
    </div>
  );
}
