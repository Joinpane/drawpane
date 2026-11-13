import type { Editor } from "@drawpane/editor";
import { BINDING_TARGETS } from "@drawpane/editor";
import {
  type BindingKey,
  getProp,
  type NodeRecord,
  type Paint,
  type PropName,
  type PropValues,
} from "@drawpane/model";
import {
  IconButton,
  type IconName,
  NumberField,
  PropertyRow,
  PropertySection,
  SegmentedControl,
  type SegmentedOption,
  Switch,
  TokenChip,
} from "@drawpane/ui";
import { useState } from "react";
import { ComponentSection } from "./ComponentSection";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { Bindable } from "./tokens/Bindable";
import { ModesSection } from "./tokens/ModesSection";

/** The value every node shares, or null when they differ (shown as "Mixed"). */
function common<K extends PropName>(nodes: readonly NodeRecord[], prop: K): PropValues[K] | null {
  const first = nodes[0];
  if (!first) return null;
  const value = getProp(first.props, prop);
  const json = JSON.stringify(value);
  return nodes.every((n) => JSON.stringify(getProp(n.props, prop)) === json) ? value : null;
}

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
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const nodes = selection.map((id) => editor.doc.get(id)).filter((n): n is NodeRecord => !!n);

  if (nodes.length === 0) return <PageInspector />;

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
  const inLayout = geometry.filter((n) => {
    const parent = editor.doc.get(n.parent);
    return parent?.type === "frame" && getProp(parent.props, "layoutMode") !== "none";
  });
  const layoutFrames = frames.filter((n) => getProp(n.props, "layoutMode") !== "none");

  return (
    <fieldset className="inspector" disabled={!canEdit} aria-label="Properties">
      <h2 className="inspector__title">{title}</h2>
      <ComponentSection nodes={nodes} />
      {geometry.length > 0 ? <GeometrySection editor={editor} nodes={geometry} /> : null}
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
    </fieldset>
  );
}

/** Wires a NumberField to the editor: commits on change, groups scrubs into one undo step. */
function Num({
  editor,
  nodes,
  prop,
  label,
  icon,
  ariaLabel,
  min,
  max,
  unit,
  scale = 1,
}: {
  editor: Editor;
  nodes: readonly NodeRecord[];
  prop: PropName;
  label?: string;
  icon?: IconName;
  ariaLabel: string;
  min?: number;
  max?: number;
  unit?: string;
  /** Shown value = stored × scale (opacity shows as percent). */
  scale?: number;
}) {
  const value = common(nodes, prop) as number | null;
  const bindKey = NUMBER_BINDINGS.has(prop) ? (prop as BindingKey) : undefined;
  const field = (token?: { name: string; open: () => void }) => (
    <NumberField
      {...(token ? { token: token.name, onTokenClick: token.open } : {})}
      {...(label ? { label } : {})}
      {...(icon ? { icon } : {})}
      ariaLabel={ariaLabel}
      {...(unit ? { unit } : {})}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      value={value === null ? null : Math.round(value * scale * 100) / 100}
      placeholder="Mixed"
      onChange={(v) =>
        editor.setProp(
          nodes.map((n) => n.id),
          prop,
          Math.round((v / scale) * 10000) / 10000,
          ariaLabel,
        )
      }
      onScrubStart={() => editor.beginGesture(ariaLabel)}
      onScrubEnd={() => editor.endGesture()}
    />
  );
  if (!bindKey) return field();
  return (
    <Bindable nodes={nodes} bindKey={bindKey}>
      {({ bound, open }) => field(bound ? { name: getProp(bound.props, "name"), open } : undefined)}
    </Bindable>
  );
}

/** Number properties a variable can drive (their binding key is the property name). */
const NUMBER_BINDINGS: ReadonlySet<string> = new Set(
  (Object.entries(BINDING_TARGETS) as Array<[BindingKey, { prop: string; type: string }]>)
    .filter(([key, t]) => t.type === "number" && t.prop === key)
    .map(([key]) => key),
);

function GeometrySection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  return (
    <PropertySection title="Position and size">
      <PropertyRow>
        <Num editor={editor} nodes={nodes} prop="x" label="X" ariaLabel="X position" />
        <Num editor={editor} nodes={nodes} prop="y" label="Y" ariaLabel="Y position" />
      </PropertyRow>
      <PropertyRow>
        <Num editor={editor} nodes={nodes} prop="width" label="W" ariaLabel="Width" min={0} />
        <Num editor={editor} nodes={nodes} prop="height" label="H" ariaLabel="Height" min={0} />
      </PropertyRow>
      <PropertyRow>
        <Num
          editor={editor}
          nodes={nodes}
          prop="rotation"
          icon="rotate"
          ariaLabel="Rotation"
          unit="°"
        />
      </PropertyRow>
    </PropertySection>
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

function AppearanceSection({
  editor,
  nodes,
  corners,
  frames,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  corners: NodeRecord[];
  frames: NodeRecord[];
}) {
  const clip = common(frames, "clipContent");
  return (
    <PropertySection title="Appearance">
      <PropertyRow>
        <Num
          editor={editor}
          nodes={nodes}
          prop="opacity"
          icon="opacity"
          ariaLabel="Opacity"
          unit="%"
          min={0}
          max={100}
          scale={100}
        />
        {corners.length === nodes.length ? (
          <Num
            editor={editor}
            nodes={corners}
            prop="cornerRadius"
            icon="radius"
            ariaLabel="Corner radius"
            min={0}
          />
        ) : (
          <span />
        )}
      </PropertyRow>
      {frames.length === nodes.length ? (
        <PropertyRow columns="label">
          <span className="inspector__label">Clip</span>
          <Switch
            label="Clip content"
            checked={clip ?? false}
            onChange={(checked) =>
              editor.setProp(
                frames.map((f) => f.id),
                "clipContent",
                checked ? null : false,
                "Clip content",
              )
            }
          />
        </PropertyRow>
      ) : null}
    </PropertySection>
  );
}

const FONTS = [
  "Instrument Sans",
  "Instrument Serif",
  "JetBrains Mono",
  "system-ui",
  "Georgia",
  "Helvetica",
  "Times New Roman",
  "Courier New",
];
const WEIGHTS = [
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semibold"],
  [700, "Bold"],
] as const;

function TextSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const family = common(nodes, "fontFamily");
  const weight = common(nodes, "fontWeight");
  const align = common(nodes, "textAlign");
  const lineHeight = common(nodes, "lineHeight");
  const letterSpacing = common(nodes, "letterSpacing");
  const auto = common(nodes, "textAutoResize");
  return (
    <PropertySection title="Text">
      <select
        className="inspector__select"
        aria-label="Font"
        value={family ?? ""}
        onChange={(e) => editor.setProp(ids, "fontFamily", e.target.value, "Font")}
      >
        {family === null ? <option value="">Mixed</option> : null}
        {[...new Set([...(family ? [family] : []), ...FONTS])].map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <PropertyRow>
        <select
          className="inspector__select"
          aria-label="Weight"
          value={weight ?? ""}
          onChange={(e) => editor.setProp(ids, "fontWeight", Number(e.target.value), "Font weight")}
        >
          {weight === null ? <option value="">Mixed</option> : null}
          {WEIGHTS.map(([w, label]) => (
            <option key={w} value={w}>
              {label}
            </option>
          ))}
        </select>
        <Num
          editor={editor}
          nodes={nodes}
          prop="fontSize"
          label="Aa"
          ariaLabel="Font size"
          min={1}
        />
      </PropertyRow>
      <PropertyRow>
        <NumberField
          icon="line-height"
          ariaLabel="Line height"
          placeholder="Auto"
          value={lineHeight && lineHeight.unit === "px" ? lineHeight.value : null}
          onChange={(v) =>
            editor.setProp(ids, "lineHeight", { unit: "px", value: v }, "Line height")
          }
        />
        <NumberField
          icon="letter-spacing"
          ariaLabel="Letter spacing"
          placeholder="Mixed"
          value={letterSpacing && letterSpacing.unit === "px" ? letterSpacing.value : null}
          onChange={(v) =>
            editor.setProp(ids, "letterSpacing", { unit: "px", value: v }, "Letter spacing")
          }
        />
      </PropertyRow>
      <SegmentedControl
        label="Text alignment"
        options={[
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ]}
        value={align ?? ""}
        onChange={(value) => editor.setProp(ids, "textAlign", value, "Text alignment")}
      />
      <SegmentedControl
        label="Text box sizing"
        options={[
          { value: "width", label: "Auto width" },
          { value: "height", label: "Auto height" },
          { value: "none", label: "Fixed" },
        ]}
        value={auto ?? ""}
        onChange={(value) => editor.setProp(ids, "textAutoResize", value, "Text sizing")}
      />
    </PropertySection>
  );
}

function ColorField({
  color,
  onChange,
  label,
}: {
  color: string;
  onChange: (color: string) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const hex = color.slice(0, 7);
  const commit = (text: string) => {
    let c = text.trim().toLowerCase().replace(/^#?/, "#");
    if (/^#[0-9a-f]{3}$/.test(c)) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    if (/^#[0-9a-f]{6}$/.test(c)) onChange(c + color.slice(7));
    setDraft(null);
  };
  return (
    <span className="color-field">
      <input
        type="color"
        className="color-field__swatch"
        aria-label={`${label} color`}
        value={hex}
        onChange={(e) => onChange(e.target.value + color.slice(7))}
      />
      <input
        className="color-field__hex"
        aria-label={`${label} hex`}
        value={draft ?? hex.slice(1).toUpperCase()}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </span>
  );
}

function PaintSection({
  editor,
  nodes,
  prop,
  title,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  prop: "fills" | "strokes";
  title: string;
}) {
  const ids = nodes.map((n) => n.id);
  const paints = common(nodes, prop);
  const set = (next: Paint[], label: string) =>
    editor.setProp(ids, prop, next.length ? next : null, label);
  const firstSolid = (paints ?? []).findIndex((p) => p.type === "solid");
  const add = () =>
    set(
      [...(paints ?? []), { type: "solid", color: prop === "fills" ? "#d9d9d6" : "#1c1b1a" }],
      `Add ${title.toLowerCase()}`,
    );

  return (
    <PropertySection
      title={title}
      actions={<IconButton icon="plus" label={`Add ${title.toLowerCase()}`} onClick={add} />}
    >
      {paints === null ? (
        <p className="inspector__mixed">Mixed {title.toLowerCase()}s. Add one to replace them.</p>
      ) : (
        paints.map((paint, i) => (
          <div key={i} className="paint-row">
            {paint.type === "solid" && i === firstSolid ? (
              <Bindable nodes={nodes} bindKey={prop === "fills" ? "fill" : "stroke"}>
                {({ bound, open }) =>
                  bound ? (
                    <TokenChip
                      className="paint-token"
                      name={getProp(bound.props, "name")}
                      swatch={paint.color.slice(0, 7)}
                      onClick={open}
                    />
                  ) : (
                    <ColorField
                      label={title}
                      color={paint.color}
                      onChange={(color) =>
                        set(
                          paints.map((p, j) => (j === i ? { ...paint, color } : p)),
                          `${title} color`,
                        )
                      }
                    />
                  )
                }
              </Bindable>
            ) : paint.type === "solid" ? (
              <ColorField
                label={title}
                color={paint.color}
                onChange={(color) =>
                  set(
                    paints.map((p, j) => (j === i ? { ...paint, color } : p)),
                    `${title} color`,
                  )
                }
              />
            ) : (
              <span className="inspector__mixed">
                {paint.type === "image" ? "Image" : "Gradient"}
              </span>
            )}
            <NumberField
              ariaLabel={`${title} opacity`}
              unit="%"
              min={0}
              max={100}
              value={Math.round((paint.opacity ?? 1) * 100)}
              onChange={(v) =>
                set(
                  paints.map((p, j) => (j === i ? { ...paint, opacity: v / 100 } : p)),
                  `${title} opacity`,
                )
              }
            />
            <IconButton
              icon={paint.visible === false ? "eye-off" : "eye"}
              label={
                paint.visible === false
                  ? `Show ${title.toLowerCase()}`
                  : `Hide ${title.toLowerCase()}`
              }
              onClick={() =>
                set(
                  paints.map((p, j) =>
                    j === i ? { ...paint, visible: paint.visible === false } : p,
                  ),
                  `Toggle ${title.toLowerCase()}`,
                )
              }
            />
            <IconButton
              icon="minus"
              label={`Remove ${title.toLowerCase()}`}
              onClick={() =>
                set(
                  paints.filter((_, j) => j !== i),
                  `Remove ${title.toLowerCase()}`,
                )
              }
            />
          </div>
        ))
      )}
      {prop === "strokes" && paints && paints.length > 0 ? (
        <PropertyRow>
          <Num
            editor={editor}
            nodes={nodes}
            prop="strokeWeight"
            icon="stroke-weight"
            ariaLabel="Stroke weight"
            min={0}
          />
          <select
            className="inspector__select"
            aria-label="Stroke position"
            value={common(nodes, "strokeAlign") ?? ""}
            onChange={(e) => editor.setProp(ids, "strokeAlign", e.target.value, "Stroke position")}
          >
            <option value="inside">Inside</option>
            <option value="center">Center</option>
            <option value="outside">Outside</option>
          </select>
        </PropertyRow>
      ) : null}
    </PropertySection>
  );
}

function EffectsSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const effects = common(nodes, "effects");
  const set = (next: PropValues["effects"], label: string) =>
    editor.setProp(ids, "effects", next.length ? next : null, label);
  return (
    <PropertySection
      title="Effects"
      actions={
        <IconButton
          icon="plus"
          label="Add shadow"
          onClick={() =>
            set(
              [
                ...(effects ?? []),
                { type: "drop-shadow", color: "#00000033", x: 0, y: 4, blur: 12, spread: 0 },
              ],
              "Add shadow",
            )
          }
        />
      }
    >
      {(effects ?? []).map((effect, i) => (
        <div key={i} className="effect-row">
          <select
            className="inspector__select"
            aria-label="Effect type"
            value={effect.type}
            onChange={(e) => {
              const type = e.target.value as typeof effect.type;
              const next =
                type === "layer-blur" || type === "background-blur"
                  ? { type, radius: 8 }
                  : { type, color: "#00000033", x: 0, y: 4, blur: 12, spread: 0 };
              set(effects?.map((x, j) => (j === i ? next : x)) ?? [], "Effect type");
            }}
          >
            <option value="drop-shadow">Drop shadow</option>
            <option value="inner-shadow">Inner shadow</option>
            <option value="layer-blur">Layer blur</option>
          </select>
          {effect.type === "drop-shadow" || effect.type === "inner-shadow" ? (
            <PropertyRow columns={3}>
              <NumberField
                label="X"
                ariaLabel="Shadow X"
                value={effect.x}
                onChange={(x) =>
                  set(effects?.map((e2, j) => (j === i ? { ...effect, x } : e2)) ?? [], "Shadow")
                }
              />
              <NumberField
                label="Y"
                ariaLabel="Shadow Y"
                value={effect.y}
                onChange={(y) =>
                  set(effects?.map((e2, j) => (j === i ? { ...effect, y } : e2)) ?? [], "Shadow")
                }
              />
              <NumberField
                label="B"
                ariaLabel="Shadow blur"
                min={0}
                value={effect.blur}
                onChange={(blur) =>
                  set(effects?.map((e2, j) => (j === i ? { ...effect, blur } : e2)) ?? [], "Shadow")
                }
              />
            </PropertyRow>
          ) : effect.type === "layer-blur" || effect.type === "background-blur" ? (
            <NumberField
              label="B"
              ariaLabel="Blur radius"
              min={0}
              value={effect.radius}
              onChange={(radius) =>
                set(effects?.map((e2, j) => (j === i ? { ...effect, radius } : e2)) ?? [], "Blur")
              }
            />
          ) : null}
          <IconButton
            icon="minus"
            label="Remove effect"
            onClick={() => set(effects?.filter((_, j) => j !== i) ?? [], "Remove effect")}
          />
        </div>
      ))}
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
          <ColorField
            label="Background"
            color={background}
            onChange={(color) =>
              editor.setProp([page.id], "backgroundColor", color.slice(0, 7), "Page background")
            }
          />
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
