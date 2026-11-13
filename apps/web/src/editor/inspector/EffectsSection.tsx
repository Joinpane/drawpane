/**
 * Effects: drop and inner shadows, layer and background blur. Each effect is
 * a summary row (type, values, visibility); opening it shows every value,
 * with the shadow's color in a full picker (alpha included).
 */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord, PropValues } from "@drawpane/model";
import { IconButton, NumberField, PropertyRow, PropertySection } from "@drawpane/ui";
import { useState } from "react";
import { ColorRow } from "./ColorRow";
import { common, Select } from "./fields";
import { swatchCss } from "./paint";

type Effect = PropValues["effects"][number];

const TYPE_OPTIONS = [
  { value: "drop-shadow", label: "Drop shadow" },
  { value: "inner-shadow", label: "Inner shadow" },
  { value: "layer-blur", label: "Layer blur" },
  { value: "background-blur", label: "Background blur" },
] as const;

const TYPE_LABEL: Record<Effect["type"], string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<Effect["type"], string>;

const DEFAULT_SHADOW = { color: "#00000040", x: 0, y: 4, blur: 12, spread: 0 } as const;

/** A fresh effect of `type`, keeping what carries over (visibility, shadow values). */
function effectOfType(type: Effect["type"], from?: Effect): Effect {
  const visible = from?.visible === false ? { visible: false } : {};
  if (type === "layer-blur" || type === "background-blur")
    return { type, radius: from && "radius" in from ? from.radius : 8, ...visible };
  const shadow = from && "color" in from ? from : DEFAULT_SHADOW;
  return {
    type,
    color: shadow.color,
    x: shadow.x,
    y: shadow.y,
    blur: shadow.blur,
    spread: shadow.spread,
    ...visible,
  };
}

/** "0 4 12 0" for shadows (x, y, blur, spread), the radius for blurs. */
function summary(e: Effect): string {
  if ("radius" in e) return `${e.radius}`;
  return `${e.x} ${e.y} ${e.blur} ${e.spread}`;
}

export function EffectsSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const effects = common(nodes, "effects");
  const [open, setOpen] = useState<number | null>(null);
  const set = (next: Effect[], label: string) =>
    editor.setProp(ids, "effects", next.length ? next : null, label);
  const replace = (i: number, next: Effect, label: string) =>
    set(
      (effects ?? []).map((e, j) => (j === i ? next : e)),
      label,
    );

  return (
    <PropertySection
      title="Effects"
      actions={
        <IconButton
          icon="plus"
          label="Add effect"
          onClick={() => {
            const list = effects ?? [];
            set([...list, effectOfType("drop-shadow")], "Add shadow");
            setOpen(list.length);
          }}
        />
      }
    >
      {effects === null ? (
        <p className="inspector__mixed">Mixed effects. Add one to replace them.</p>
      ) : (
        effects.map((effect, i) => {
          const expanded = open === i;
          return (
            <div key={i} className="effect" data-hidden={effect.visible === false || undefined}>
              <div className="effect__row">
                <button
                  type="button"
                  className="effect__toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : i)}
                >
                  {"color" in effect ? (
                    <span
                      className="effect__swatch"
                      style={{ background: swatchCss({ type: "solid", color: effect.color }) }}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="effect__swatch effect__swatch--blur" aria-hidden="true" />
                  )}
                  <span className="effect__name">{TYPE_LABEL[effect.type]}</span>
                  <span className="effect__summary">{summary(effect)}</span>
                </button>
                <IconButton
                  icon={effect.visible === false ? "eye-off" : "eye"}
                  label={effect.visible === false ? "Show effect" : "Hide effect"}
                  onClick={() =>
                    replace(i, { ...effect, visible: effect.visible === false }, "Toggle effect")
                  }
                />
                <IconButton
                  icon="minus"
                  label="Remove effect"
                  onClick={() => {
                    set(
                      effects.filter((_, j) => j !== i),
                      "Remove effect",
                    );
                    setOpen(null);
                  }}
                />
              </div>
              {expanded ? (
                <EffectDetails
                  editor={editor}
                  effect={effect}
                  onChange={(next, label) => replace(i, next, label)}
                />
              ) : null}
            </div>
          );
        })
      )}
    </PropertySection>
  );
}

function EffectDetails({
  editor,
  effect,
  onChange,
}: {
  editor: Editor;
  effect: Effect;
  onChange: (next: Effect, label: string) => void;
}) {
  const scrub = (label: string) => ({
    onScrubStart: () => editor.beginGesture(label),
    onScrubEnd: () => editor.endGesture(),
  });
  return (
    <div className="effect__details">
      <Select
        label="Effect type"
        value={effect.type}
        options={TYPE_OPTIONS}
        onChange={(type) => onChange(effectOfType(type, effect), "Effect type")}
      />
      {"color" in effect ? (
        <>
          <PropertyRow>
            <NumberField
              label="X"
              ariaLabel="Shadow X offset"
              value={effect.x}
              onChange={(x) => onChange({ ...effect, x }, "Shadow offset")}
              {...scrub("Shadow offset")}
            />
            <NumberField
              label="Y"
              ariaLabel="Shadow Y offset"
              value={effect.y}
              onChange={(y) => onChange({ ...effect, y }, "Shadow offset")}
              {...scrub("Shadow offset")}
            />
          </PropertyRow>
          <PropertyRow>
            <NumberField
              label="B"
              ariaLabel="Shadow blur"
              min={0}
              value={effect.blur}
              onChange={(blur) => onChange({ ...effect, blur }, "Shadow blur")}
              {...scrub("Shadow blur")}
            />
            <NumberField
              label="S"
              ariaLabel="Shadow spread"
              value={effect.spread}
              onChange={(spread) => onChange({ ...effect, spread }, "Shadow spread")}
              {...scrub("Shadow spread")}
            />
          </PropertyRow>
          <ColorRow
            editor={editor}
            label="Shadow"
            color={effect.color}
            onChange={(color, label) => onChange({ ...effect, color }, label)}
          />
        </>
      ) : (
        <NumberField
          label="R"
          ariaLabel="Blur radius"
          min={0}
          value={effect.radius}
          onChange={(radius) => onChange({ ...effect, radius }, "Blur radius")}
          {...scrub("Blur radius")}
        />
      )}
    </div>
  );
}
