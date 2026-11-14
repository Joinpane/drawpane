import {
  componentSetOf,
  type Editor,
  instanceRootOf,
  isMainComponent,
  variantProperties,
} from "@drawpane/editor";
import { getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { IconButton, type IconName, KIND_ICONS, NumberField, SelectionLens } from "@drawpane/ui";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { shortcutFor } from "./actions";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { FontPicker } from "./inspector/FontPicker";
import { common } from "./inspector/fields";
import { PaintSwatch } from "./inspector/PaintSection";
import { TextStyleTrigger } from "./inspector/TextStyles";
import { WeightSelect } from "./inspector/TypographyFields";
import { layerKind } from "./layer-kinds";
import { kindOf } from "./layer-tree";
import { type Box, hasLabelAbove, type LensSide, lensObstacles, placeLens } from "./lens-placement";
import { textViews } from "./text-views";
import { useUi } from "./ui-state";

/** Clear of the top bar (file title, tools, share) at 12–52px. */
const TOP = 64;
/** Clear of the zoom bar at the bottom. */
const BOTTOM = 56;
const MARGIN = 8;
/** Until the Lens has been measured. */
const ESTIMATE = { width: 280, height: 40 };

/**
 * The Selection Lens: a compact strip beside the selection with the four or
 * five controls that matter for that layer type (see the SelectionLens spec),
 * so your eyes stay on the work. It sits under the selection unless that
 * would cover the layers around it, and the full inspector is one keypress
 * away. People can turn it off from the View menu or the command bar.
 */
export function Lens({ onOpenInspector }: { onOpenInspector: () => void }) {
  const editor = useEditor();
  useDocVersion();
  const enabled = useUi(editor, (ui) => ui.lens);
  const selection = useEditorState((s) => s.selection);
  const camera = useEditorState((s) => s.camera);
  const viewport = useEditorState((s) => s.viewport);
  const gesture = useEditorState((s) => s.gesture);
  // Vector edit has its own marks on the canvas; keep the path clear.
  const vectorEdit = useEditorState((s) => s.vectorEdit !== null || s.cropping !== null);
  const editing = useEditorState((s) => s.editingText);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const tool = useEditorState((s) => s.tool);
  // The Prototype tab puts connection handles where the Lens would sit.
  const prototyping = useEditorState((s) => s.prototyping);
  // Explain takes the place beside the selection.
  const explaining = useEditorState((s) => s.explain !== null);
  const scrubbing = useRef(false);
  // One of the Lens's popovers (font, style, fill) is open: stay put while it's in use.
  const [holding, setHolding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(ESTIMATE);
  const [bounds, setBounds] = useState({ left: 0, right: Number.POSITIVE_INFINITY });
  const previous = useRef<LensSide | null>(null);
  // Appear once the selection has settled, so a quick follow-up click (like a
  // Shift-click on the layer just below) lands on the canvas, not the Lens.
  const [settled, setSettled] = useState(false);
  const [shift, setShift] = useState(false);
  const selectionKey = selection.join(",");
  useEffect(() => {
    setSettled(false);
    previous.current = null;
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
  // Measure the Lens and the side panes; placement runs on the next render (before paint).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      Math.abs(el.offsetWidth - size.width) > 0.5 ||
      Math.abs(el.offsetHeight - size.height) > 0.5
    )
      setSize({ width: el.offsetWidth, height: el.offsetHeight });
    const host = (el.offsetParent ?? document.body).getBoundingClientRect();
    const leftPane = document.querySelector(".pane--left")?.getBoundingClientRect();
    const rightPane = document.querySelector(".pane--right")?.getBoundingClientRect();
    const left = leftPane ? leftPane.right - host.left : 0;
    const right = rightPane ? rightPane.left - host.left : Number.POSITIVE_INFINITY;
    if (left !== bounds.left || right !== bounds.right) setBounds({ left, right });
  });

  // Hide during canvas gestures, but not while scrubbing one of our own
  // fields or using one of our popovers: unmounting then would lose the
  // gesture's end, or close the popover under the pointer.
  const held = holding || scrubbing.current;
  const hidden =
    !enabled ||
    selection.length !== 1 ||
    (!held && (gesture || !settled || shift)) ||
    editing !== null ||
    vectorEdit ||
    !canEdit ||
    prototyping ||
    explaining ||
    tool !== "select";
  if (hidden && holding) setHolding(false);
  if (hidden) return null;
  const node = editor.doc.get(selection[0] as string);
  const world = node ? editor.scene.bounds(node.id) : null;
  if (!node || !world || node.type === "group") return null;

  const toScreen = (r: Box): Box => {
    const a = camera.toScreen({ x: r.x, y: r.y });
    const b = camera.toScreen({ x: r.x + r.width, y: r.y + r.height });
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const right = Math.min(bounds.right, viewport.width);
  const area: Box = {
    x: bounds.left + MARGIN,
    y: TOP,
    width: right - MARGIN - (bounds.left + MARGIN),
    height: viewport.height - BOTTOM - TOP,
  };
  // While a popover or a scrub is in use, keep to the same side so nothing jumps under the pointer.
  const placement = placeLens({
    target: toScreen(world),
    size,
    area,
    obstacles: lensObstacles(editor.doc, editor.scene, node.id).map(toScreen),
    labelAbove: hasLabelAbove(editor.doc, node.id),
    previous: previous.current,
    ...(held && previous.current ? { sides: [previous.current] } : {}),
  });
  if (!placement) return null;
  if (!held) previous.current = placement.side;

  const hold = (open: boolean) => setHolding(open);
  const { kind, icon, controls } = lensContents(editor, node, {
    hold,
    scrubbing,
    // Popovers open away from the selection.
    side: placement.side === "above" ? "top" : "bottom",
  });

  return (
    <div
      ref={ref}
      className="lens-anchor"
      data-side={placement.side}
      style={{ left: placement.x, top: placement.y }}
    >
      <SelectionLens
        kind={kind}
        kindIcon={icon}
        onOpenInspector={onOpenInspector}
        inspectorShortcut={shortcutFor("view.rightPane") ?? ""}
      >
        {controls}
      </SelectionLens>
    </div>
  );
}

interface LensContext {
  /** A popover opened or closed. */
  hold: (open: boolean) => void;
  scrubbing: { current: boolean };
  side: "top" | "bottom";
}

/** What the Lens shows for a layer: its kind and the controls the SelectionLens spec lists for it. */
function lensContents(
  editor: Editor,
  node: NodeRecord,
  ctx: LensContext,
): { kind: string; icon: IconName; controls: ReactNode[] } {
  const p = node.props;
  const nodes = [node];
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
        ctx.scrubbing.current = true;
        editor.beginGesture(aria);
      }}
      onScrubEnd={() => {
        ctx.scrubbing.current = false;
        editor.endGesture();
      }}
    />
  );
  const prop = (
    name: "width" | "height" | "gap" | "cornerRadius" | "fontSize",
    aria: string,
    look: { label: string } | { icon: IconName },
  ) => field(name, getProp(p, name), aria, look, (v) => editor.setProp([node.id], name, v, aria));
  const size = [prop("width", "Width", { label: "W" }), prop("height", "Height", { label: "H" })];
  const fill = <FillControl key="fill" editor={editor} node={node} ctx={ctx} />;
  const base = layerKind(node.type);
  // The same glyph as the layers panel: auto layout direction, component, image…
  const icon = KIND_ICONS[kindOf(node)];

  // Text: font token (its text style, or its font), weight, size, fill.
  if (node.type === "text") {
    const styled = getProp(p, "textStyle") !== null;
    // Every look among its characters: a bold word makes the weight "Mixed".
    const views = textViews(editor, nodes);
    return {
      kind: base.label,
      icon,
      controls: [
        styled ? (
          <TextStyleTrigger
            key="style"
            editor={editor}
            nodes={nodes}
            side={ctx.side}
            compact
            onOpenChange={ctx.hold}
          />
        ) : (
          <FontPicker
            key="font"
            editor={editor}
            nodes={views}
            side={ctx.side}
            compact
            onOpenChange={ctx.hold}
          />
        ),
        <WeightSelect key="weight" editor={editor} nodes={views} className="lens-select" />,
        field("fontSize", common(views, "fontSize"), "Font size", { label: "Aa" }, (v) =>
          editor.setProp([node.id], "fontSize", v, "Font size"),
        ),
        fill,
      ],
    };
  }

  // An instance of a variant: switch its properties right here.
  const root = instanceRootOf(editor.doc, node.id);
  if (root?.id === node.id) {
    const mainId = getProp(p, "instanceOf");
    const main = mainId ? editor.doc.get(mainId) : undefined;
    const set = main ? componentSetOf(editor.doc, main.id) : undefined;
    const current = main ? getProp(main.props, "variantProps") : {};
    const variants = set
      ? variantProperties(editor.doc, set.id)
          .slice(0, 2)
          .map((property) => (
            <select
              key={`variant:${property.name}`}
              className="inspector__select lens-select"
              aria-label={property.name}
              title={property.name}
              value={current[property.name] ?? ""}
              onChange={(e) => editor.setInstanceVariant(node.id, property.name, e.target.value)}
            >
              {property.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ))
      : [];
    return { kind: "Instance", icon, controls: [...variants, ...size] };
  }

  // Auto layout: W, H, gap, padding.
  if (node.type === "frame" && getProp(p, "layoutMode") !== "none") {
    const paddings = [
      getProp(p, "paddingTop"),
      getProp(p, "paddingRight"),
      getProp(p, "paddingBottom"),
      getProp(p, "paddingLeft"),
    ];
    const uniform = paddings.every((v) => v === paddings[0]) ? (paddings[0] ?? 0) : null;
    return {
      kind: `${base.label} · ${getProp(p, "layoutMode") === "grid" ? "Grid" : "Auto layout"}`,
      icon,
      controls: [
        ...size,
        prop("gap", "Gap", {
          icon: getProp(p, "layoutMode") === "column" ? "gap-vertical" : "gap-horizontal",
        }),
        field("padding", uniform, "Padding", { icon: "padding" }, (v) => {
          editor.beginGesture("Padding");
          for (const side of [
            "paddingTop",
            "paddingRight",
            "paddingBottom",
            "paddingLeft",
          ] as const)
            editor.setProp([node.id], side, v, "Padding");
          editor.endGesture();
        }),
      ],
    };
  }

  // Shapes and frames: W, H, fill, radius. A line has no fill.
  const rounded = node.type === "frame" || node.type === "rect";
  return {
    kind: isMainComponent(node) ? "Component" : base.label,
    icon,
    controls: [
      ...size,
      ...(node.type === "line" ? [] : [fill]),
      ...(rounded ? [prop("cornerRadius", "Corner radius", { icon: "radius" })] : []),
    ],
  };
}

/** The topmost fill's swatch (its picker opens from the Lens), or a button to add one. */
function FillControl({
  editor,
  node,
  ctx,
}: {
  editor: Editor;
  node: NodeRecord;
  ctx: LensContext;
}) {
  const fills = getProp(node.props, "fills");
  if (fills.length === 0)
    return (
      <IconButton
        icon="plus"
        label="Add fill"
        onClick={() =>
          editor.setProp(
            [node.id],
            "fills",
            [{ type: "solid", color: node.type === "text" ? "#1c1b1a" : "#d9d9d6" }],
            "Add fill",
          )
        }
      />
    );
  const index = fills.length - 1;
  const paint = fills[index] as Paint;
  const firstSolid = fills.findIndex((f) => f.type === "solid");
  return (
    <PaintSwatch
      editor={editor}
      nodes={[node]}
      title="Fill"
      paint={paint}
      bindKey={index === firstSolid ? "fill" : undefined}
      side={ctx.side}
      onOpenChange={ctx.hold}
      onChange={(next, label) =>
        editor.setProp(
          [node.id],
          "fills",
          fills.map((f, i) => (i === index ? next : f)),
          label,
        )
      }
    />
  );
}
