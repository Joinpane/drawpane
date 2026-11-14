/**
 * Effects: drop and inner shadows, layer and background blur.
 *
 * "+" opens a menu of effect types; picking one adds it and opens its
 * editor. Each effect is a row (its kind, a glance at its values, show or
 * hide, remove); the row opens the editor in a popover beside the
 * inspector, where the kind can change and every value is labelled.
 */
import type { Editor } from "@drawpane/editor";
import {
  DEFAULT_GLASS,
  type Glass,
  glassBounds,
  type NodeRecord,
  type PropValues,
} from "@drawpane/model";
import {
  DropdownMenu,
  Icon,
  IconButton,
  type IconName,
  LightDial,
  MenuButton,
  type MenuItem,
  NumberField,
  Popover,
  PropertySection,
  SliderField,
} from "@drawpane/ui";
import { useRef, useState } from "react";
import { ColorRow } from "./ColorRow";
import { common } from "./fields";

type Effect = PropValues["effects"][number];
type EffectType = Effect["type"];

/** The kinds of effect, in the order the menu lists them. */
export const EFFECT_KINDS: ReadonlyArray<{ type: EffectType; label: string; icon: IconName }> = [
  { type: "drop-shadow", label: "Drop shadow", icon: "drop-shadow" },
  { type: "inner-shadow", label: "Inner shadow", icon: "inner-shadow" },
  { type: "layer-blur", label: "Layer blur", icon: "layer-blur" },
  { type: "background-blur", label: "Background blur", icon: "background-blur" },
  { type: "glass", label: "Glass", icon: "glass" },
];

const KIND = Object.fromEntries(EFFECT_KINDS.map((k) => [k.type, k])) as Record<
  EffectType,
  (typeof EFFECT_KINDS)[number]
>;

const DEFAULT_SHADOW = { color: "#00000040", x: 0, y: 4, blur: 12, spread: 0 } as const;

/** A fresh effect of `type`, keeping what carries over (visibility, shadow values). */
export function effectOfType(type: EffectType, from?: Effect): Effect {
  const visible = from?.visible === false ? { visible: false } : {};
  if (type === "glass") return { ...DEFAULT_GLASS, ...visible };
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

/** A glance at the values: "0 4 12 0" for a shadow (x, y, blur, spread), the radius for a blur. */
export function effectSummary(e: Effect): string {
  if (e.type === "glass") return `${e.refraction} ${e.depth} ${e.frost}`;
  if ("radius" in e) return `${e.radius}`;
  return `${e.x} ${e.y} ${e.blur} ${e.spread}`;
}

export function EffectsSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const effects = common(nodes, "effects");
  // The effect whose editor is open, by index.
  const [open, setOpen] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLButtonElement>());
  const set = (next: Effect[], label: string) =>
    editor.setProp(ids, "effects", next.length ? next : null, label);
  const replace = (i: number, next: Effect, label: string) =>
    set(
      (effects ?? []).map((e, j) => (j === i ? next : e)),
      label,
    );

  const addItems: MenuItem[] = EFFECT_KINDS.map((kind) => ({
    id: kind.type,
    label: kind.label,
    icon: kind.icon,
    onSelect: () => {
      const list = effects ?? [];
      set([...list, effectOfType(kind.type)], `Add ${kind.label.toLowerCase()}`);
      // Its editor opens once its row is there.
      requestAnimationFrame(() => setOpen(list.length));
    },
  }));

  const anchor = open === null ? null : (rows.current.get(open) ?? null);
  const current = open === null ? null : (effects?.[open] ?? null);

  return (
    <PropertySection
      title="Effects"
      actions={<MenuButton icon="plus" label="Add effect" items={addItems} />}
    >
      {effects === null ? (
        <p className="inspector__mixed">Mixed effects. Add one to replace them.</p>
      ) : (
        effects.map((effect, i) => {
          const kind = KIND[effect.type];
          const hidden = effect.visible === false;
          return (
            <div
              key={i}
              className="effect"
              data-hidden={hidden || undefined}
              data-open={open === i || undefined}
            >
              <button
                ref={(el) => {
                  if (el) rows.current.set(i, el);
                  else rows.current.delete(i);
                }}
                type="button"
                className="effect__toggle"
                aria-haspopup="dialog"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? null : i)}
              >
                <Icon name={kind.icon} size={16} />
                <span className="effect__name">{kind.label}</span>
                <span className="effect__summary">{effectSummary(effect)}</span>
              </button>
              <IconButton
                icon={hidden ? "eye-off" : "eye"}
                label={
                  hidden ? `Show ${kind.label.toLowerCase()}` : `Hide ${kind.label.toLowerCase()}`
                }
                onClick={() => replace(i, { ...effect, visible: hidden }, "Toggle effect")}
              />
              <IconButton
                icon="minus"
                label={`Remove ${kind.label.toLowerCase()}`}
                onClick={() => {
                  set(
                    effects.filter((_, j) => j !== i),
                    "Remove effect",
                  );
                  setOpen(null);
                }}
              />
            </div>
          );
        })
      )}
      {anchor && current && open !== null ? (
        <Popover
          anchor={anchor}
          label={KIND[current.type].label}
          className="effect-editor dp-root"
          autoFocus={false}
          onClose={() => setOpen(null)}
        >
          <EffectEditor
            editor={editor}
            effect={current}
            onChange={(next, label) => replace(open, next, label)}
            onClose={() => setOpen(null)}
          />
        </Popover>
      ) : null}
    </PropertySection>
  );
}

/** One effect's editor: its kind (switchable), then each value with its name. */
function EffectEditor({
  editor,
  effect,
  onChange,
  onClose,
}: {
  editor: Editor;
  effect: Effect;
  onChange: (next: Effect, label: string) => void;
  onClose: () => void;
}) {
  const kind = KIND[effect.type];
  const typeButton = useRef<HTMLButtonElement>(null);
  const [choosing, setChoosing] = useState(false);
  const scrub = (label: string) => ({
    onScrubStart: () => editor.beginGesture(label),
    onScrubEnd: () => editor.endGesture(),
  });
  return (
    <div className="effect-editor__body">
      <div className="effect-editor__head">
        <button
          ref={typeButton}
          type="button"
          className="effect-editor__type"
          aria-haspopup="menu"
          aria-expanded={choosing}
          aria-label={`Effect type: ${kind.label}`}
          onClick={() => setChoosing(!choosing)}
        >
          <Icon name={kind.icon} size={16} />
          <span>{kind.label}</span>
          <Icon name="chevron-down" size={12} />
        </button>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      {choosing && typeButton.current ? (
        <DropdownMenu
          anchor={typeButton.current}
          label="Effect type"
          align="start"
          items={EFFECT_KINDS.map((k) => ({
            id: k.type,
            label: k.label,
            icon: k.icon,
            checked: k.type === effect.type,
            // With icons the menu shows no check: the current kind starts highlighted instead.
            active: k.type === effect.type,
            onSelect: () => onChange(effectOfType(k.type, effect), "Effect type"),
          }))}
          onClose={() => setChoosing(false)}
        />
      ) : null}
      {effect.type === "glass" ? (
        <GlassFields effect={effect} onChange={onChange} scrub={scrub} />
      ) : null}
      <div className="effect-editor__fields" hidden={effect.type === "glass"}>
        {effect.type === "glass" ? null : "color" in effect ? (
          <>
            <span className="effect-editor__label">Position</span>
            <div className="effect-editor__pair">
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
            <span className="effect-editor__label">Blur</span>
            <NumberField
              icon="layer-blur"
              ariaLabel="Shadow blur"
              min={0}
              value={effect.blur}
              onChange={(blur) => onChange({ ...effect, blur }, "Shadow blur")}
              {...scrub("Shadow blur")}
            />
            <span className="effect-editor__label">Spread</span>
            <NumberField
              icon="padding"
              ariaLabel="Shadow spread"
              value={effect.spread}
              onChange={(spread) => onChange({ ...effect, spread }, "Shadow spread")}
              {...scrub("Shadow spread")}
            />
            <span className="effect-editor__label">Color</span>
            <ColorRow
              editor={editor}
              label="Shadow"
              color={effect.color}
              onChange={(color, label) => onChange({ ...effect, color }, label)}
            />
          </>
        ) : (
          <>
            <span className="effect-editor__label">Blur</span>
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
        <span className="effect-editor__label">{label}</span>
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
      <div className="effect-editor__fields effect-editor__fields--light">
        <span className="effect-editor__label">Light</span>
        <div className="effect-editor__light">
          <LightDial
            angle={effect.angle}
            onChange={(angle) => onChange({ ...effect, angle }, "Light angle")}
            onDragStart={light.onScrubStart}
            onDragEnd={light.onScrubEnd}
          />
          <div className="effect-editor__light-values">
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
      <div className="effect-editor__fields effect-editor__fields--sliders">
        {slider("refraction", "Refraction")}
        {slider("depth", "Depth")}
        {slider("dispersion", "Dispersion")}
        {slider("frost", "Frost")}
        {slider("splay", "Splay")}
      </div>
    </>
  );
}
