/**
 * The design inspector: every property of the selection, in the order you
 * reach for them. With nothing selected it shows the page; with the frame
 * tool on, frame sizes to start from.
 */
import type { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import {
  ColorPicker,
  IconButton,
  Popover,
  PropertyRow,
  PropertySection,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from "@drawpane/ui";
import { useRef, useState } from "react";
import { ComponentSection } from "../ComponentSection";
import { useDocVersion, useEditor, useEditorState } from "../hooks";
import { ModesSection } from "../tokens/ModesSection";
import { CombineSection, PathSection } from "../VectorSections";
import { AlignSection } from "./AlignSection";
import { AppearanceSection } from "./AppearanceSection";
import { ConstraintsSection } from "./ConstraintsSection";
import { EffectsSection } from "./EffectsSection";
import { FramePresets } from "./FramePresets";
import { common, Num } from "./fields";
import { GeometrySection } from "./GeometrySection";
import { HexField, PaintSection } from "./PaintSection";
import { SelectionColors } from "./SelectionColors";
import { TextSection } from "./TextSection";
import "./inspector.css";

const TYPE_LABEL: Record<string, string> = {
  frame: "Frame",
  group: "Group",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  path: "Vector",
  text: "Text",
};

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
            : (TYPE_LABEL[only ?? ""] ?? "Layer")
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
        <SizingSection editor={editor} nodes={[...new Set([...inLayout, ...layoutFrames])]} />
      ) : null}
      {frames.length > 0 && frames.length === nodes.length ? (
        <AutoLayoutSection editor={editor} nodes={frames} />
      ) : null}
      {only === "frame" && first ? <ModesSection node={first} /> : null}
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

const SIZING: readonly SegmentedOption[] = [
  { value: "fixed", label: "Fixed" },
  { value: "hug", label: "Hug" },
  { value: "fill", label: "Fill" },
];

function SizingSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const h = common(nodes, "sizingH");
  const v = common(nodes, "sizingV");
  return (
    <PropertySection title="Resizing">
      <PropertyRow columns="label">
        <span className="inspector__label">Width</span>
        <SegmentedControl
          label="Horizontal resizing"
          options={SIZING}
          value={h ?? ""}
          onChange={(value) => editor.setProp(ids, "sizingH", value, "Resizing")}
        />
      </PropertyRow>
      <PropertyRow columns="label">
        <span className="inspector__label">Height</span>
        <SegmentedControl
          label="Vertical resizing"
          options={SIZING}
          value={v ?? ""}
          onChange={(value) => editor.setProp(ids, "sizingV", value, "Resizing")}
        />
      </PropertyRow>
    </PropertySection>
  );
}

const JUSTIFY = ["start", "center", "end"] as const;
const ALIGN = ["start", "center", "end"] as const;

function AutoLayoutSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const mode = common(nodes, "layoutMode");
  const on = mode !== "none" && mode !== null;
  const justify = common(nodes, "justifyContent");
  const align = common(nodes, "alignItems");
  const row = mode === "row";

  const toggle = () => {
    if (on) editor.setProp(ids, "layoutMode", null, "Remove auto layout");
    else {
      editor.beginGesture("Add auto layout");
      editor.setProp(ids, "layoutMode", "row");
      editor.setProp(ids, "gap", 8);
      editor.endGesture();
    }
  };

  return (
    <PropertySection
      title="Auto layout"
      actions={
        <IconButton
          icon={on ? "minus" : "plus"}
          label={on ? "Remove auto layout" : "Add auto layout"}
          shortcut="⇧A"
          onClick={toggle}
        />
      }
    >
      {on ? (
        <>
          <PropertyRow>
            <SegmentedControl
              label="Direction"
              options={[
                { value: "row", icon: "layout-row", title: "Horizontal" },
                { value: "column", icon: "layout-col", title: "Vertical" },
              ]}
              value={mode ?? ""}
              onChange={(value) => editor.setProp(ids, "layoutMode", value, "Direction")}
            />
            <Num
              editor={editor}
              nodes={nodes}
              prop="gap"
              icon={row ? "gap-horizontal" : "gap-vertical"}
              ariaLabel="Gap between items"
            />
          </PropertyRow>
          <div className="inspector__layout">
            <fieldset className="inspector__align" aria-label="Alignment">
              {ALIGN.map((a) =>
                JUSTIFY.map((j) => {
                  // Rows: columns = justify (main axis), rows = align. Columns: transposed.
                  const jj = row ? j : a;
                  const aa = row ? a : j;
                  const active =
                    justify === jj && (align === aa || (align === "stretch" && aa === "start"));
                  return (
                    <button
                      key={`${a}-${j}`}
                      type="button"
                      className="inspector__align-dot"
                      aria-pressed={active}
                      aria-label={`Justify ${jj}, align ${aa}`}
                      onClick={() => {
                        editor.beginGesture("Alignment");
                        editor.setProp(ids, "justifyContent", jj);
                        editor.setProp(ids, "alignItems", aa);
                        editor.endGesture();
                      }}
                    />
                  );
                }),
              )}
            </fieldset>
            <div className="inspector__padding">
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingLeft"
                label="L"
                ariaLabel="Left padding"
                min={0}
              />
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingRight"
                label="R"
                ariaLabel="Right padding"
                min={0}
              />
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingTop"
                label="T"
                ariaLabel="Top padding"
                min={0}
              />
              <Num
                editor={editor}
                nodes={nodes}
                prop="paddingBottom"
                label="B"
                ariaLabel="Bottom padding"
                min={0}
              />
            </div>
          </div>
          <PropertyRow columns="label">
            <span className="inspector__label">Spread</span>
            <Switch
              label="Space between"
              checked={justify === "space-between"}
              onChange={(checked) =>
                editor.setProp(
                  ids,
                  "justifyContent",
                  checked ? "space-between" : "start",
                  "Justify",
                )
              }
            />
          </PropertyRow>
        </>
      ) : null}
    </PropertySection>
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
