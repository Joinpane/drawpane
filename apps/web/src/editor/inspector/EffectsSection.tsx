/**
 * Effects: drop and inner shadows, layer and background blur, glass,
 * noise and texture.
 *
 * "+" opens a menu of effect types; picking one adds it and opens its
 * editor. Each effect is a row (its kind, a glance at its values, show or
 * hide, remove); the row opens the editor in a popover beside the
 * inspector, where the kind can change and every value is labelled.
 */
import type { Editor } from "@drawpane/editor";
import {
  DEFAULT_GLASS,
  DEFAULT_NOISE,
  DEFAULT_TEXTURE,
  effectBounds,
  type Glass,
  glassBounds,
  type NodeRecord,
  type Noise,
  type NoiseType,
  type PropValues,
  type Texture,
} from "@drawpane/model";
import {
  type IconName,
  LightDial,
  NumberField,
  PropertySection,
  SegmentedControl,
  SliderField,
  Switch,
} from "@drawpane/ui";
import { ColorRow } from "./ColorRow";
import { common } from "./fields";
import { AddItemButton, ItemEditor, ItemRow, useItemEditor } from "./ItemList";

type Effect = PropValues["effects"][number];
type EffectType = Effect["type"];

/** The kinds of effect, in the order the menu lists them. */
export const EFFECT_KINDS: ReadonlyArray<{ type: EffectType; label: string; icon: IconName }> = [
  { type: "drop-shadow", label: "Drop shadow", icon: "drop-shadow" },
  { type: "inner-shadow", label: "Inner shadow", icon: "inner-shadow" },
  { type: "layer-blur", label: "Layer blur", icon: "layer-blur" },
  { type: "background-blur", label: "Background blur", icon: "background-blur" },
  { type: "glass", label: "Glass", icon: "glass" },
  { type: "noise", label: "Noise", icon: "noise" },
  { type: "texture", label: "Texture", icon: "texture" },
];

/** Effects whose editor has sliders, and wants the room. */
const WIDE: ReadonlySet<EffectType> = new Set(["glass", "noise", "texture"]);

const NOISE_TYPES: ReadonlyArray<{ value: NoiseType; label: string }> = [
  { value: "mono", label: "Mono" },
  { value: "duo", label: "Duo" },
  { value: "multi", label: "Multi" },
];

const KIND = Object.fromEntries(EFFECT_KINDS.map((k) => [k.type, k])) as Record<
  EffectType,
  (typeof EFFECT_KINDS)[number]
>;

const DEFAULT_SHADOW = { color: "#00000040", x: 0, y: 4, blur: 12, spread: 0 } as const;

const isShadow = (e: Effect | undefined) => e?.type === "drop-shadow" || e?.type === "inner-shadow";
const isBlur = (e: Effect | undefined) => e?.type === "layer-blur" || e?.type === "background-blur";

/** A fresh effect of `type`, keeping what carries over (visibility; a shadow's or blur's values). */
export function effectOfType(type: EffectType, from?: Effect): Effect {
  const visible = from?.visible === false ? { visible: false } : {};
  if (type === "glass") return { ...DEFAULT_GLASS, ...visible };
  if (type === "noise") return { ...DEFAULT_NOISE, ...visible };
  if (type === "texture") return { ...DEFAULT_TEXTURE, ...visible };
  if (type === "layer-blur" || type === "background-blur")
    return { type, radius: from && isBlur(from) && "radius" in from ? from.radius : 8, ...visible };
  const shadow = from && isShadow(from) && "x" in from ? from : DEFAULT_SHADOW;
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

/**
 * A glance at the values: "0 4 12 0" for a shadow (x, y, blur, spread), the
 * radius for a blur, "Mono · 50%" for noise (its kind and density).
 */
export function effectSummary(e: Effect): string {
  switch (e.type) {
    case "glass":
      return `${e.refraction} ${e.depth} ${e.frost}`;
    case "noise":
      return `${NOISE_TYPES.find((t) => t.value === e.noiseType)?.label ?? ""} · ${e.density}%`;
    case "texture":
      return `${e.size} ${e.radius}`;
    case "layer-blur":
    case "background-blur":
      return `${e.radius}`;
    default:
      return `${e.x} ${e.y} ${e.blur} ${e.spread}`;
  }
}

export function EffectsSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const effects = common(nodes, "effects");
  const items = useItemEditor();
  const set = (next: Effect[], label: string) =>
    editor.setProp(ids, "effects", next.length ? next : null, label);
  const replace = (i: number, next: Effect, label: string) =>
    set(
      (effects ?? []).map((e, j) => (j === i ? next : e)),
      label,
    );
  const current = items.open === null ? null : (effects?.[items.open] ?? null);

  return (
    <PropertySection
      title="Effects"
      actions={
        <AddItemButton
          label="Add effect"
          kinds={EFFECT_KINDS}
          onAdd={(type) => {
            const list = effects ?? [];
            set([...list, effectOfType(type)], `Add ${KIND[type].label.toLowerCase()}`);
            items.openNew(list.length);
          }}
        />
      }
    >
      {effects === null ? (
        <p className="inspector__mixed">Mixed effects. Add one to replace them.</p>
      ) : (
        effects.map((effect, i) => (
          <ItemRow
            key={i}
            kind={KIND[effect.type]}
            summary={effectSummary(effect)}
            hidden={effect.visible === false}
            open={items.open === i}
            buttonRef={items.rowRef(i)}
            onOpen={() => items.toggle(i)}
            onToggleHidden={() =>
              replace(i, { ...effect, visible: effect.visible === false }, "Toggle effect")
            }
            onRemove={() => {
              set(
                effects.filter((_, j) => j !== i),
                "Remove effect",
              );
              items.setOpen(null);
            }}
          />
        ))
      )}
      {items.anchor && current && items.open !== null ? (
        <ItemEditor
          anchor={items.anchor}
          kinds={EFFECT_KINDS}
          current={current.type}
          kindLabel="Effect type"
          className={WIDE.has(current.type) ? "item-editor--wide" : undefined}
          onKind={(type) =>
            replace(items.open as number, effectOfType(type, current), "Effect type")
          }
          onClose={() => items.setOpen(null)}
        >
          <EffectFields
            editor={editor}
            effect={current}
            onChange={(next, label) => replace(items.open as number, next, label)}
          />
        </ItemEditor>
      ) : null}
    </PropertySection>
  );
}

/** One effect's values, each with its name. */
function EffectFields({
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
  if (effect.type === "glass")
    return <GlassFields effect={effect} onChange={onChange} scrub={scrub} />;
  if (effect.type === "noise")
    return <NoiseFields editor={editor} effect={effect} onChange={onChange} scrub={scrub} />;
  if (effect.type === "texture")
    return <TextureFields effect={effect} onChange={onChange} scrub={scrub} />;
  return (
    <div className="item-editor__fields">
      {/* Only shadows and blurs are left: a shadow has an offset. */}
      {"x" in effect ? (
        <>
          <span className="item-editor__label">Position</span>
          <div className="item-editor__pair">
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
          </div>
          <span className="item-editor__label">Blur</span>
          <NumberField
            icon="layer-blur"
            ariaLabel="Shadow blur"
            min={0}
            value={effect.blur}
            onChange={(blur) => onChange({ ...effect, blur }, "Shadow blur")}
            {...scrub("Shadow blur")}
          />
          <span className="item-editor__label">Spread</span>
          <NumberField
            icon="padding"
            ariaLabel="Shadow spread"
            value={effect.spread}
            onChange={(spread) => onChange({ ...effect, spread }, "Shadow spread")}
            {...scrub("Shadow spread")}
          />
          <span className="item-editor__label">Color</span>
          <ColorRow
            editor={editor}
            label="Shadow"
            color={effect.color}
            onChange={(color, label) => onChange({ ...effect, color }, label)}
          />
        </>
      ) : (
        <>
          <span className="item-editor__label">Blur</span>
          <NumberField
            icon="layer-blur"
            ariaLabel="Blur radius"
            min={0}
            value={effect.radius}
            onChange={(radius) => onChange({ ...effect, radius }, "Blur radius")}
            {...scrub("Blur radius")}
          />
        </>
      )}
    </div>
  );
}

/** The glass's values: its light (a dial, the angle and intensity), then its lens. */
function GlassFields({
  effect,
  onChange,
  scrub,
}: {
  effect: Glass;
  onChange: (next: Effect, label: string) => void;
  scrub: (label: string) => { onScrubStart: () => void; onScrubEnd: () => void };
}) {
  const slider = (
    key: "refraction" | "depth" | "dispersion" | "frost" | "splay",
    label: string,
  ) => {
    const { min = 0, max = 100 } = glassBounds(key);
    const drag = scrub(label);
    return (
      <>
        <span className="item-editor__label">{label}</span>
        <SliderField
          label={label}
          value={effect[key]}
          min={min}
          max={max}
          onChange={(v) => onChange({ ...effect, [key]: v }, label)}
          onScrubStart={drag.onScrubStart}
          onScrubEnd={drag.onScrubEnd}
        />
      </>
    );
  };
  const light = scrub("Light angle");
  return (
    <>
      <div className="item-editor__fields item-editor__fields--light">
        <span className="item-editor__label">Light</span>
        <div className="item-editor__light">
          <LightDial
            angle={effect.angle}
            onChange={(angle) => onChange({ ...effect, angle }, "Light angle")}
            onDragStart={light.onScrubStart}
            onDragEnd={light.onScrubEnd}
          />
          <div className="item-editor__light-values">
            <NumberField
              ariaLabel="Light angle"
              unit="°"
              min={-180}
              max={180}
              value={effect.angle}
              onChange={(angle) => onChange({ ...effect, angle }, "Light angle")}
              {...light}
            />
            <NumberField
              ariaLabel="Light intensity"
              unit="%"
              min={0}
              max={100}
              value={effect.intensity}
              onChange={(intensity) => onChange({ ...effect, intensity }, "Light intensity")}
              {...scrub("Light intensity")}
            />
          </div>
        </div>
      </div>
      <div className="item-editor__fields item-editor__fields--sliders">
        {slider("refraction", "Refraction")}
        {slider("depth", "Depth")}
        {slider("dispersion", "Dispersion")}
        {slider("frost", "Frost")}
        {slider("splay", "Splay")}
      </div>
    </>
  );
}

type Scrub = (label: string) => { onScrubStart: () => void; onScrubEnd: () => void };

/** A labelled slider for one of an effect's numbers, with its range from the model. */
function EffectSlider<E extends Noise | Texture>({
  effect,
  field,
  label,
  unit,
  curve,
  onChange,
  scrub,
}: {
  effect: E;
  field: keyof E & ("size" | "density" | "opacity" | "radius");
  label: string;
  unit?: string;
  curve?: number;
  onChange: (next: Effect, label: string) => void;
  scrub: Scrub;
}) {
  const { min = 0, max = 100 } = effectBounds(effect.type, field as never);
  const drag = scrub(label);
  return (
    <>
      <span className="item-editor__label">{label}</span>
      <SliderField
        label={label}
        value={effect[field] as number}
        min={min}
        max={max}
        step={field === "size" ? 0.5 : 1}
        {...(unit ? { unit } : {})}
        {...(curve ? { curve } : {})}
        onChange={(v) => onChange({ ...effect, [field]: v }, label)}
        onScrubStart={drag.onScrubStart}
        onScrubEnd={drag.onScrubEnd}
      />
    </>
  );
}

/**
 * Noise's values: its kind (mono, duo, multi), the grain's size and how
 * much of the layer it covers, then its colour, two colours or opacity.
 */
function NoiseFields({
  editor,
  effect,
  onChange,
  scrub,
}: {
  editor: Editor;
  effect: Noise;
  onChange: (next: Effect, label: string) => void;
  scrub: Scrub;
}) {
  const slider = { effect, onChange, scrub };
  return (
    <div className="item-editor__fields">
      <span className="item-editor__label">Type</span>
      <SegmentedControl
        label="Noise type"
        className="item-editor__segments"
        options={NOISE_TYPES}
        value={effect.noiseType}
        onChange={(noiseType) => onChange({ ...effect, noiseType }, "Noise type")}
      />
      <EffectSlider {...slider} field="size" label="Size" curve={2.5} />
      <EffectSlider {...slider} field="density" label="Density" unit="%" />
      {effect.noiseType === "multi" ? (
        <EffectSlider {...slider} field="opacity" label="Opacity" unit="%" />
      ) : (
        <>
          <span className="item-editor__label item-editor__label--top">
            {effect.noiseType === "duo" ? "Colors" : "Color"}
          </span>
          <div className="item-editor__stack">
            <ColorRow
              editor={editor}
              label="Noise"
              color={effect.color}
              onChange={(color, label) => onChange({ ...effect, color }, label)}
            />
            {effect.noiseType === "duo" ? (
              <ColorRow
                editor={editor}
                label="Second noise"
                color={effect.secondaryColor}
                onChange={(secondaryColor, label) => onChange({ ...effect, secondaryColor }, label)}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** Texture's values: the grain's size, how far it roughens, and whether it stays inside. */
function TextureFields({
  effect,
  onChange,
  scrub,
}: {
  effect: Texture;
  onChange: (next: Effect, label: string) => void;
  scrub: Scrub;
}) {
  const slider = { effect, onChange, scrub };
  return (
    <div className="item-editor__fields">
      <EffectSlider {...slider} field="size" label="Size" curve={2.5} />
      <EffectSlider {...slider} field="radius" label="Radius" curve={2} />
      <span aria-hidden="true" />
      <Switch
        label="Clip to shape"
        checked={effect.clipToShape}
        onChange={(clipToShape) => onChange({ ...effect, clipToShape }, "Clip texture to shape")}
      />
    </div>
  );
}
