/**
 * The design inspector: every property of the selection, in the order you
 * reach for them. With nothing selected it shows the page; with the frame
 * tool on, frame sizes to start from.
 */
import type { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { ColorPicker, IconButton, Popover, PropertySection } from "@drawpane/ui";
import { useRef, useState } from "react";
import { ComponentSection } from "../ComponentSection";
import { useDocVersion, useEditor, useEditorState } from "../hooks";
import { layerKind } from "../layer-kinds";
import { ModesSection } from "../tokens/ModesSection";
import { CombineSection, PathSection } from "../VectorSections";
import { AlignSection } from "./AlignSection";
import { AppearanceSection } from "./AppearanceSection";
import { ConstraintsSection } from "./ConstraintsSection";
import { EffectsSection } from "./EffectsSection";
import { FramePresets } from "./FramePresets";
import { GeometrySection } from "./GeometrySection";
import { LayoutGridsSection } from "./LayoutGridsSection";
import { AutoLayoutSection, GridItemSection, SizingSection } from "./LayoutSection";
import { HexField, PaintSection } from "./PaintSection";
import { SelectionColors } from "./SelectionColors";
import { ShapeSection } from "./ShapeSection";
import { TextSection } from "./TextSection";
import "./inspector.css";

export function Inspector() {
  const editor = useEditor();
  useDocVersion();
  const selection = useEditorState((s) => s.selection);
  const tool = useEditorState((s) => s.tool);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const nodes = selection.map((id) => editor.doc.get(id)).filter((n): n is NodeRecord => !!n);

  if (nodes.length === 0)
    return tool === "frame" && canEdit ? <FramePresets editor={editor} /> : <PageInspector />;

  const types = new Set(nodes.map((n) => n.type));
  const only = types.size === 1 ? nodes[0]?.type : null;
  const first = nodes[0];
  const title =
    nodes.length === 1 && first
      ? getProp(first.props, "isComponentSet")
        ? "Component set"
        : getProp(first.props, "isComponent")
          ? "Component"
          : getProp(first.props, "instanceOf") !== null
            ? "Instance"
            : layerKind(only ?? "").label
      : `${nodes.length} layers`;
  const geometry = nodes.filter((n) => n.type !== "group");
  const frames = nodes.filter((n) => n.type === "frame");
  const texts = nodes.filter((n) => n.type === "text");
  const shapes = nodes.filter((n) => n.type !== "group");
  const corners = nodes.filter((n) => n.type === "frame" || n.type === "rect");
  const layoutOf = (n: NodeRecord) => {
    const parent = editor.doc.get(n.parent);
    return parent?.type === "frame" ? getProp(parent.props, "layoutMode") : null;
  };
  // Grid items in the flow (absolute ones leave the grid).
  const gridItems = geometry.filter(
    (n) => layoutOf(n) === "grid" && getProp(n.props, "positioning") === "auto",
  );
  const inLayout = geometry.filter((n) => {
    const mode = layoutOf(n);
    return mode !== null && mode !== "none";
  });
  const layoutFrames = frames.filter((n) => getProp(n.props, "layoutMode") !== "none");
  // Constraints apply where the frame leaves a layer where it is.
  const constrained = nodes.every((n) => {
    const mode = layoutOf(n);
    return mode !== null && (mode === "none" || getProp(n.props, "positioning") === "absolute");
  });

  return (
    <fieldset className="inspector" disabled={!canEdit} aria-label="Properties">
      <h2 className="inspector__title">{title}</h2>
      <AlignSection editor={editor} nodes={nodes} />
      <ComponentSection nodes={nodes} />
      {nodes.length > 1 ? <CombineSection editor={editor} /> : null}
      {geometry.length > 0 ? <GeometrySection editor={editor} nodes={geometry} /> : null}
      {constrained ? <ConstraintsSection editor={editor} nodes={nodes} /> : null}
      {inLayout.length > 0 || layoutFrames.length > 0 ? (
        <SizingSection
          editor={editor}
          nodes={[...new Set([...inLayout, ...layoutFrames])]}
          items={inLayout}
        />
      ) : null}
      {gridItems.length > 0 && gridItems.length === nodes.length ? (
        <GridItemSection editor={editor} nodes={gridItems} />
      ) : null}
      {frames.length > 0 && frames.length === nodes.length ? (
        <AutoLayoutSection editor={editor} nodes={frames} />
      ) : null}
      {frames.length > 0 && frames.length === nodes.length ? (
        <LayoutGridsSection editor={editor} nodes={frames} />
      ) : null}
      {only === "frame" && first ? <ModesSection node={first} /> : null}
      <ShapeSection editor={editor} nodes={nodes} />
      <AppearanceSection editor={editor} nodes={nodes} corners={corners} frames={frames} />
      {texts.length > 0 && texts.length === nodes.length ? (
        <TextSection editor={editor} nodes={texts} />
      ) : null}
      {shapes.length > 0 ? (
        <PaintSection editor={editor} nodes={shapes} prop="fills" title="Fill" />
      ) : null}
      {shapes.length > 0 ? (
        <PaintSection editor={editor} nodes={shapes} prop="strokes" title="Stroke" />
      ) : null}
      {shapes.length > 0 ? <EffectsSection editor={editor} nodes={shapes} /> : null}
      <SelectionColors editor={editor} nodes={nodes} />
      <PathSection editor={editor} nodes={nodes} />
    </fieldset>
  );
}

function PageInspector() {
  const editor = useEditor();
  useDocVersion();
  const pageId = useEditorState((s) => s.pageId);
  const page = pageId ? editor.doc.get(pageId) : undefined;
  if (!page) return null;
  const background = getProp(page.props, "backgroundColor");
  return (
    <div className="inspector">
      <h2 className="inspector__title">Page</h2>
      <ModesSection node={page} />
      <PropertySection
        title="Background"
        actions={
          background ? (
            <IconButton
              icon="close"
              label="Use the theme's canvas color"
              onClick={() => editor.setProp([page.id], "backgroundColor", null, "Page background")}
            />
          ) : null
        }
      >
        {background ? (
          <div className="paint-row paint-row--page">
            <PageSwatch editor={editor} pageId={page.id} color={background} />
            <HexField
              label="Background"
              color={background}
              onChange={(color) =>
                editor.setProp([page.id], "backgroundColor", color.slice(0, 7), "Page background")
              }
            />
          </div>
        ) : (
          <button
            type="button"
            className="inspector__default"
            onClick={() =>
              editor.setProp([page.id], "backgroundColor", "#ebeae6", "Page background")
            }
          >
            <span className="inspector__default-swatch" aria-hidden="true" />
            <span>Follows your theme</span>
            <span className="inspector__default-action">Set a color</span>
          </button>
        )}
      </PropertySection>
      <p className="inspector__hint">
        Select a layer to edit it, or press ⌘K to search and set values by name.
      </p>
    </div>
  );
}

/** The page background's swatch: an opaque color picker. */
function PageSwatch({ editor, pageId, color }: { editor: Editor; pageId: string; color: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="paint-swatch"
        aria-label="Edit page background"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ background: color }}
        onClick={() => setOpen((o) => !o)}
      />
      {open && ref.current ? (
        <Popover
          anchor={ref.current}
          label="Page background"
          className="paint-picker dp-root"
          onClose={() => setOpen(false)}
        >
          <div className="paint-picker__body">
            <ColorPicker
              label="Background"
              alpha={false}
              value={color}
              onChange={(hex) =>
                editor.setProp([pageId], "backgroundColor", hex.slice(0, 7), "Page background")
              }
              onChangeStart={() => editor.beginGesture("Page background")}
              onChangeEnd={() => editor.endGesture()}
            />
          </div>
        </Popover>
      ) : null}
    </>
  );
}
