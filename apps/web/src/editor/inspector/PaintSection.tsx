/**
 * Fill and Stroke: a row per paint (topmost first, as it stacks) with a
 * swatch that opens the paint picker, its hex or kind, opacity, visibility
 * and remove. Strokes add weight, position, dashes, caps and joins.
 */
import { type Editor, isClosedPath, textContrast } from "@drawpane/editor";
import { getProp, type NodeRecord, type Paint, type StrokeMarker } from "@drawpane/model";
import {
  Icon,
  IconButton,
  NumberField,
  PropertyRow,
  PropertySection,
  parseColor,
  SegmentedControl,
  TokenChip,
  toHex,
} from "@drawpane/ui";
import { useRef, useState } from "react";
import { ImageChip } from "../ImageFill";
import { Bindable } from "../tokens/Bindable";
import { common, Num, Select } from "./fields";
import { PaintPicker } from "./PaintPicker";
import { gradientAngle, rgbaOf, swatchCss } from "./paint";

export function PaintSection({
  editor,
  nodes,
  prop,
  title,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  prop: "fills" | "strokes";
  title: "Fill" | "Stroke";
}) {
  const ids = nodes.map((n) => n.id);
  const paints = common(nodes, prop);
  const lower = title.toLowerCase();
  const set = (next: Paint[], label: string) =>
    editor.setProp(ids, prop, next.length ? next : null, label);
  const firstSolid = (paints ?? []).findIndex((p) => p.type === "solid");
  const add = () =>
    set(
      [...(paints ?? []), { type: "solid", color: prop === "fills" ? "#d9d9d6" : "#1c1b1a" }],
      `Add ${lower}`,
    );
  // The topmost paint draws last; list it first, like the layers panel.
  const order = (paints ?? []).map((_, i) => i).reverse();

  return (
    <PropertySection
      title={title}
      actions={<IconButton icon="plus" label={`Add ${lower}`} onClick={add} />}
    >
      {paints === null ? (
        <p className="inspector__mixed">Mixed {lower}s. Add one to replace them.</p>
      ) : (
        order.map((i) => {
          const paint = paints[i] as Paint;
          const replace = (next: Paint, label: string) =>
            set(
              paints.map((p, j) => (j === i ? next : p)),
              label,
            );
          return (
            <div key={i} className="paint-row" data-hidden={paint.visible === false || undefined}>
              <PaintSwatch
                editor={editor}
                nodes={nodes}
                title={title}
                paint={paint}
                bindKey={i === firstSolid ? (prop === "fills" ? "fill" : "stroke") : undefined}
                onChange={replace}
              />
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
                      <HexField
                        label={title}
                        color={paint.color}
                        onChange={(color) => replace({ ...paint, color }, `${title} color`)}
                      />
                    )
                  }
                </Bindable>
              ) : paint.type === "solid" ? (
                <HexField
                  label={title}
                  color={paint.color}
                  onChange={(color) => replace({ ...paint, color }, `${title} color`)}
                />
              ) : paint.type === "image" ? (
                <ImageChip editor={editor} paint={paint} />
              ) : (
                <span className="paint-row__kind">
                  {paint.type === "linear"
                    ? `Linear ${gradientAngle(paint)}°`
                    : paint.type === "angular"
                      ? `Angular ${gradientAngle(paint)}°`
                      : "Radial"}
                </span>
              )}
              <NumberField
                ariaLabel={`${title} opacity`}
                unit="%"
                min={0}
                max={100}
                precision={0}
                value={Math.round((paint.opacity ?? 1) * 100)}
                onChange={(v) => replace({ ...paint, opacity: v / 100 }, `${title} opacity`)}
                onScrubStart={() => editor.beginGesture(`${title} opacity`)}
                onScrubEnd={() => editor.endGesture()}
              />
              <IconButton
                icon={paint.visible === false ? "eye-off" : "eye"}
                label={paint.visible === false ? `Show ${lower}` : `Hide ${lower}`}
                onClick={() =>
                  replace({ ...paint, visible: paint.visible === false }, `Toggle ${lower}`)
                }
              />
              <IconButton
                icon="minus"
                label={`Remove ${lower}`}
                onClick={() =>
                  set(
                    paints.filter((_, j) => j !== i),
                    `Remove ${lower}`,
                  )
                }
              />
            </div>
          );
        })
      )}
      {prop === "strokes" && paints && paints.length > 0 ? (
        <StrokeOptions editor={editor} nodes={nodes} />
      ) : null}
      {prop === "fills" && nodes.length === 1 && nodes[0]?.type === "text" ? (
        <ContrastNote editor={editor} id={nodes[0].id} />
      ) : null}
    </PropertySection>
  );
}

/** How the text stands against what's behind it, WCAG-style: "17.8:1 on #FFFFFF · AAA". */
function ContrastNote({ editor, id }: { editor: Editor; id: string }) {
  const contrast = textContrast(editor.doc, id);
  if (!contrast) return null;
  const pass = contrast.level !== "fail";
  return (
    <p
      className={`contrast-note contrast-note--${pass ? "pass" : "fail"}`}
      title={`WCAG 2 contrast for ${contrast.large ? "large" : "body"} text: AA needs ${contrast.large ? "3" : "4.5"}:1, AAA ${contrast.large ? "4.5" : "7"}:1.`}
    >
      <Icon name={pass ? "check" : "warning"} size={12} />
      <span>
        <strong>{contrast.ratio}:1</strong> on {contrast.background.toUpperCase()}
      </span>
      <span className="contrast-note__level">{pass ? contrast.level : "Low contrast"}</span>
    </p>
  );
}

/** The paint's swatch: opens the picker beside the inspector. */
function PaintSwatch({
  editor,
  nodes,
  title,
  paint,
  bindKey,
  onChange,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  title: "Fill" | "Stroke";
  paint: Paint;
  bindKey: "fill" | "stroke" | undefined;
  onChange: (next: Paint, label: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="paint-swatch"
        aria-label={`Edit ${title.toLowerCase()}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ background: swatchCss(paint) }}
        onClick={() => setOpen((o) => !o)}
      >
        {paint.type === "image" ? <Icon name="image" size={12} /> : null}
      </button>
      {open && ref.current ? (
        <PaintPicker
          editor={editor}
          anchor={ref.current}
          label={title}
          paint={paint}
          nodes={nodes}
          bindKey={bindKey}
          kinds={title === "Fill" ? ["solid", "gradient", "image"] : ["solid", "gradient"]}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Hex of a solid color; takes any CSS color, keeps the color's own alpha. */
export function HexField({
  color,
  onChange,
  label,
}: {
  color: string;
  onChange: (color: string) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    const c = parseColor(text);
    if (c) {
      const typedAlpha = !/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text.trim());
      const next = toHex(typedAlpha ? c : { ...c, a: rgbaOf(color).a });
      if (next !== color) onChange(next);
    }
    setDraft(null);
  };
  return (
    <input
      className="paint-hex"
      aria-label={`${label} hex`}
      value={draft ?? color.slice(1, 7).toUpperCase()}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value);
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const ALIGN_OPTIONS = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Center" },
  { value: "outside", label: "Outside" },
] as const;

function StrokeOptions({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const dashes = common(nodes, "strokeDashes");
  const capped = nodes.filter((n) => n.type === "line" || n.type === "path");
  // Open strokes (lines, unclosed paths) run along their centre and can have end markers.
  const open = capped.filter(
    (n) => n.type === "line" || !isClosedPath(getProp(n.props, "pathData")),
  );
  const joined = nodes.filter((n) => n.type !== "line" && n.type !== "ellipse");
  const cap = common(capped, "strokeCap");
  const join = common(joined, "strokeJoin");
  const dash = dashes?.[0] ?? 0;
  const gap = dashes?.[1] ?? dashes?.[0] ?? 0;
  const setDashes = (d: number, g: number) =>
    editor.setProp(ids, "strokeDashes", d > 0 ? [d, g > 0 ? g : d] : null, "Stroke dashes");
  return (
    <>
      <PropertyRow>
        <Num
          editor={editor}
          nodes={nodes}
          prop="strokeWeight"
          icon="stroke-weight"
          ariaLabel="Stroke weight"
          min={0}
        />
        {/* Lines and open paths always stroke along their centre. */}
        {open.length === nodes.length ? (
          <span />
        ) : (
          <Select
            label="Stroke position"
            value={common(nodes, "strokeAlign")}
            options={ALIGN_OPTIONS}
            onChange={(v) => editor.setProp(ids, "strokeAlign", v, "Stroke position")}
          />
        )}
      </PropertyRow>
      <PropertyRow columns="label">
        <span className="inspector__label">Dash</span>
        <span className="inspector__pair">
          <NumberField
            icon="dash"
            ariaLabel="Dash length"
            min={0}
            placeholder={dashes === null ? "Mixed" : "0"}
            value={dashes === null ? null : dash}
            onChange={(d) => setDashes(d, gap || d)}
          />
          <NumberField
            icon="gap-horizontal"
            ariaLabel="Gap between dashes"
            min={0}
            placeholder={dashes === null ? "Mixed" : "0"}
            value={dashes === null ? null : gap}
            onChange={(g) => setDashes(dash || g, g)}
          />
        </span>
      </PropertyRow>
      {capped.length === nodes.length ? (
        <PropertyRow columns="label">
          <span className="inspector__label">Caps</span>
          <SegmentedControl
            label="Stroke caps"
            options={[
              { value: "none", label: "None" },
              { value: "round", label: "Round" },
              { value: "square", label: "Square" },
            ]}
            value={cap ?? ""}
            onChange={(v) => editor.setProp(ids, "strokeCap", v, "Stroke caps")}
          />
        </PropertyRow>
      ) : null}
      {open.length === nodes.length ? <StrokeEnds editor={editor} nodes={open} /> : null}
      {joined.length === nodes.length ? (
        <PropertyRow columns="label">
          <span className="inspector__label">Joins</span>
          <SegmentedControl
            label="Stroke joins"
            options={[
              { value: "miter", label: "Miter" },
              { value: "round", label: "Round" },
              { value: "bevel", label: "Bevel" },
            ]}
            value={join ?? ""}
            onChange={(v) => editor.setProp(ids, "strokeJoin", v, "Stroke joins")}
          />
        </PropertyRow>
      ) : null}
    </>
  );
}

const MARKERS: ReadonlyArray<{ value: StrokeMarker; label: string }> = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "triangle", label: "Triangle" },
  { value: "circle", label: "Circle" },
  { value: "diamond", label: "Diamond" },
  { value: "bar", label: "Bar" },
];

/** Start and end markers on lines and open paths, and a button that swaps them. */
function StrokeEnds({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const start = common(nodes, "markerStart");
  const end = common(nodes, "markerEnd");
  const set = (prop: "markerStart" | "markerEnd", value: StrokeMarker, label: string) =>
    editor.setProp(ids, prop, value === "none" ? null : value, label);
  return (
    <div className="stroke-ends-block">
      <span className="inspector__label">Ends</span>
      <span className="stroke-ends">
        <Select
          label="Start of the stroke"
          value={start}
          options={MARKERS}
          onChange={(v) => set("markerStart", v, "Stroke start")}
        />
        <IconButton
          icon="flip-horizontal"
          label="Swap ends"
          disabled={start === end}
          onClick={() => {
            editor.beginGesture("Swap stroke ends");
            for (const n of nodes) {
              const s0 = getProp(n.props, "markerStart");
              const e0 = getProp(n.props, "markerEnd");
              editor.setProp([n.id], "markerStart", e0 === "none" ? null : e0);
              editor.setProp([n.id], "markerEnd", s0 === "none" ? null : s0);
            }
            editor.endGesture();
          }}
        />
        <Select
          label="End of the stroke"
          value={end}
          options={MARKERS}
          onChange={(v) => set("markerEnd", v, "Stroke end")}
        />
      </span>
    </div>
  );
}
