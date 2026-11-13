import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  cssColor,
  type Hsva,
  hexDigits,
  hslToRgb,
  hsvToRgb,
  parseColor,
  parseHex,
  type Rgba,
  rgbToHsl,
  rgbToHsv,
  toHex,
} from "../lib/color";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import { NumberField } from "./NumberField";
import { Tooltip } from "./Tooltip";

export type ColorFormat = "hex" | "rgb" | "hsl" | "hsb";

export interface ColorPickerProps
  extends Omit<ComponentPropsWithRef<"div">, "onChange" | "defaultValue" | "children"> {
  /** `#rrggbb` or `#rrggbbaa`. */
  value: string;
  /** Called with lowercase `#rrggbb`, or `#rrggbbaa` when not opaque. */
  onChange: (hex: string) => void;
  /** A drag or scrub started: open an undo group. */
  onChangeStart?: () => void;
  onChangeEnd?: () => void;
  /** Show the alpha slider and field. Default true. */
  alpha?: boolean;
  /** Accessible prefix for every control, such as "Fill". */
  label?: string;
}

const FORMAT_KEY = "drawpane:color-format";
const FORMATS: ReadonlyArray<{ value: ColorFormat; label: string }> = [
  { value: "hex", label: "Hex" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
  { value: "hsb", label: "HSB" },
];

function storedFormat(): ColorFormat {
  try {
    const f = localStorage.getItem(FORMAT_KEY);
    if (f === "hex" || f === "rgb" || f === "hsl" || f === "hsb") return f;
  } catch {
    // Storage can be unavailable (private windows): use the default.
  }
  return "hex";
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Fixed colors the picker draws with, whatever the theme: the hue spectrum,
 * the white and black of the saturation area, the transparency checkerboard
 * and the ring that keeps knobs visible on any color.
 */
export const PICKER_COLORS = {
  "--dp-picker-white": "#ffffff",
  "--dp-picker-black": "#000000",
  "--dp-picker-spectrum":
    "linear-gradient(to right, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%)",
  "--dp-picker-checker": "repeating-conic-gradient(#d2cfc8 0% 25%, #ffffff 0% 50%) 0 0 / 8px 8px",
  "--dp-picker-ring": "0 0 0 1px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.3)",
} as const;

/** The picker's own state, from a hex, keeping `keep`'s hue where the color has none (greys). */
function hsvaOf(hex: string, keep?: Hsva): Hsva {
  const rgb = parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  const next = rgbToHsv(rgb);
  if (!keep) return next;
  return {
    h: next.s === 0 || next.v === 0 ? keep.h : next.h,
    s: next.v === 0 ? keep.s : next.s,
    v: next.v,
    a: next.a,
  };
}

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open(): Promise<EyeDropperResult> };

/**
 * A full color picker: a saturation and brightness area, hue and alpha
 * sliders, an eyedropper where the browser has one, and fields in hex, RGB,
 * HSL or HSB (remembered between uses). Typing or pasting any CSS color into
 * the hex field works too. Every part works with the keyboard.
 */
export function ColorPicker({
  value,
  onChange,
  onChangeStart,
  onChangeEnd,
  alpha = true,
  label = "Color",
  className,
  style,
  ...rest
}: ColorPickerProps) {
  const [hsva, setHsva] = useState(() => hsvaOf(value));
  const [format, setFormatState] = useState<ColorFormat>(storedFormat);
  const last = useRef(value);

  // Follow outside changes (undo, another person) without losing the hue of greys.
  useEffect(() => {
    if (value.toLowerCase() === last.current.toLowerCase()) return;
    last.current = value;
    setHsva((h) => hsvaOf(value, h));
  }, [value]);

  const emit = (next: Hsva) => {
    setHsva(next);
    const hex = toHex(hsvToRgb(alpha ? next : { ...next, a: 1 }));
    if (hex === last.current.toLowerCase()) return;
    last.current = hex;
    onChange(hex);
  };
  const emitRgb = (rgb: Rgba) => emit(hsvaOf(toHex(rgb), hsva));

  const setFormat = (f: ColorFormat) => {
    setFormatState(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      // Not remembered; still works.
    }
  };

  const rgb = hsvToRgb(hsva);
  const opaque = { ...rgb, a: 1 };
  const hueColor = cssColor(hsvToRgb({ h: hsva.h, s: 1, v: 1, a: 1 }));
  const EyeDropper = (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper;

  return (
    <div
      {...rest}
      className={cx("dp-color-picker", className)}
      style={{ ...PICKER_COLORS, ...style }}
    >
      <ColorArea
        hsva={hsva}
        hueColor={hueColor}
        label={label}
        onChange={emit}
        onStart={onChangeStart}
        onEnd={onChangeEnd}
      />
      <div className="dp-color-picker__strips">
        {EyeDropper ? (
          <Tooltip label="Pick a color from the screen" describe={false}>
            <button
              type="button"
              className="dp-color-picker__dropper"
              aria-label="Pick a color from the screen"
              onClick={async () => {
                try {
                  const result = await new EyeDropper().open();
                  const picked = parseHex(result.sRGBHex);
                  if (picked) emitRgb({ ...picked, a: hsva.a });
                } catch {
                  // Cancelled with Escape.
                }
              }}
            >
              <Icon name="eyedropper" size={16} />
            </button>
          </Tooltip>
        ) : null}
        <div className="dp-color-picker__sliders">
          <ChannelSlider
            label={`${label} hue`}
            className="dp-color-picker__hue"
            value={hsva.h}
            max={360}
            unit="°"
            thumbColor={hueColor}
            onChange={(h) => emit({ ...hsva, h })}
            onStart={onChangeStart}
            onEnd={onChangeEnd}
          />
          {alpha ? (
            <ChannelSlider
              label={`${label} opacity`}
              className="dp-color-picker__alpha"
              style={{
                ["--dp-alpha-to" as string]: cssColor(opaque),
                ["--dp-alpha-from" as string]: cssColor({ ...opaque, a: 0 }),
              }}
              value={Math.round(hsva.a * 100)}
              max={100}
              unit="%"
              thumbColor={cssColor(rgb)}
              onChange={(a) => emit({ ...hsva, a: a / 100 })}
              onStart={onChangeStart}
              onEnd={onChangeEnd}
            />
          ) : null}
        </div>
      </div>
      <div className="dp-color-picker__fields" data-format={format}>
        <select
          className="dp-color-picker__format"
          aria-label="Color format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ColorFormat)}
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        {format === "hex" ? (
          <HexInput label={label} rgb={rgb} onCommit={(c) => emitRgb(alpha ? c : { ...c, a: 1 })} />
        ) : (
          <ChannelFields
            format={format}
            hsva={hsva}
            rgb={rgb}
            label={label}
            onHsva={emit}
            onRgb={emitRgb}
            onStart={onChangeStart}
            onEnd={onChangeEnd}
          />
        )}
        {alpha ? (
          <NumberField
            className="dp-color-picker__alpha-field"
            ariaLabel={`${label} opacity`}
            unit="%"
            min={0}
            max={100}
            precision={0}
            value={Math.round(hsva.a * 100)}
            onChange={(a) => emit({ ...hsva, a: clamp01(a / 100) })}
            {...(onChangeStart ? { onScrubStart: onChangeStart } : {})}
            {...(onChangeEnd ? { onScrubEnd: onChangeEnd } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The hex field: shows `RRGGBB`, accepts any CSS color on Enter or blur. */
function HexInput({
  label,
  rgb,
  onCommit,
}: {
  label: string;
  rgb: Rgba;
  onCommit: (c: Rgba) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    const c = parseColor(text);
    // Typed hex without alpha keeps the current alpha.
    if (c) onCommit(/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text.trim()) ? { ...c, a: rgb.a } : c);
    setDraft(null);
  };
  return (
    <span className="dp-color-picker__hex">
      <span aria-hidden="true">#</span>
      <input
        aria-label={`${label} hex`}
        spellCheck={false}
        autoComplete="off"
        value={draft ?? hexDigits(rgb)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "Escape" && draft !== null) {
            e.preventDefault();
            setDraft(null);
          }
        }}
      />
    </span>
  );
}

function ChannelFields({
  format,
  hsva,
  rgb,
  label,
  onHsva,
  onRgb,
  onStart,
  onEnd,
}: {
  format: Exclude<ColorFormat, "hex">;
  hsva: Hsva;
  rgb: Rgba;
  label: string;
  onHsva: (c: Hsva) => void;
  onRgb: (c: Rgba) => void;
  onStart: (() => void) | undefined;
  onEnd: (() => void) | undefined;
}) {
  const scrub = {
    ...(onStart ? { onScrubStart: onStart } : {}),
    ...(onEnd ? { onScrubEnd: onEnd } : {}),
    precision: 0,
  };
  if (format === "rgb") {
    const field = (key: "r" | "g" | "b", name: string) => (
      <NumberField
        key={key}
        label={key.toUpperCase()}
        ariaLabel={`${label} ${name}`}
        min={0}
        max={255}
        value={Math.round(rgb[key])}
        onChange={(n) => onRgb({ ...rgb, [key]: n })}
        {...scrub}
      />
    );
    return (
      <span className="dp-color-picker__channels">
        {field("r", "red")}
        {field("g", "green")}
        {field("b", "blue")}
      </span>
    );
  }
  if (format === "hsl") {
    const hsl = rgbToHsl(rgb);
    const set = (patch: Partial<typeof hsl>) => {
      const next = { ...hsl, ...patch };
      // Keep the picker's hue when lightness or saturation makes it undefined.
      const c = hsvaOf(toHex(hslToRgb(next, hsva.a)), { ...hsva, h: next.h });
      onHsva({ ...c, h: next.h });
    };
    return (
      <span className="dp-color-picker__channels">
        <NumberField
          label="H"
          ariaLabel={`${label} hue`}
          unit="°"
          min={0}
          max={360}
          value={Math.round(hsva.h)}
          onChange={(h) => set({ h })}
          {...scrub}
        />
        <NumberField
          label="S"
          ariaLabel={`${label} saturation`}
          unit="%"
          min={0}
          max={100}
          value={Math.round(hsl.s * 100)}
          onChange={(s) => set({ s: s / 100 })}
          {...scrub}
        />
        <NumberField
          label="L"
          ariaLabel={`${label} lightness`}
          unit="%"
          min={0}
          max={100}
          value={Math.round(hsl.l * 100)}
          onChange={(l) => set({ l: l / 100 })}
          {...scrub}
        />
      </span>
    );
  }
  return (
    <span className="dp-color-picker__channels">
      <NumberField
        label="H"
        ariaLabel={`${label} hue`}
        unit="°"
        min={0}
        max={360}
        value={Math.round(hsva.h)}
        onChange={(h) => onHsva({ ...hsva, h })}
        {...scrub}
      />
      <NumberField
        label="S"
        ariaLabel={`${label} saturation`}
        unit="%"
        min={0}
        max={100}
        value={Math.round(hsva.s * 100)}
        onChange={(s) => onHsva({ ...hsva, s: clamp01(s / 100) })}
        {...scrub}
      />
      <NumberField
        label="B"
        ariaLabel={`${label} brightness`}
        unit="%"
        min={0}
        max={100}
        value={Math.round(hsva.v * 100)}
        onChange={(v) => onHsva({ ...hsva, v: clamp01(v / 100) })}
        {...scrub}
      />
    </span>
  );
}

/** Pointer drags with capture; `move` gets the pointer as 0–1 fractions of the element. */
function useDrag(
  move: (fx: number, fy: number) => void,
  onStart: (() => void) | undefined,
  onEnd: (() => void) | undefined,
) {
  const active = useRef<number | null>(null);
  const at = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    move(
      clamp01((e.clientX - r.left) / (r.width || 1)),
      clamp01((e.clientY - r.top) / (r.height || 1)),
    );
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture(e.pointerId);
      active.current = e.pointerId;
      onStart?.();
      at(e);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (active.current === e.pointerId) at(e);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (active.current !== e.pointerId) return;
      active.current = null;
      onEnd?.();
    },
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => {
      if (active.current !== e.pointerId) return;
      active.current = null;
      onEnd?.();
    },
  };
}

function ColorArea({
  hsva,
  hueColor,
  label,
  onChange,
  onStart,
  onEnd,
}: {
  hsva: Hsva;
  hueColor: string;
  label: string;
  onChange: (c: Hsva) => void;
  onStart: (() => void) | undefined;
  onEnd: (() => void) | undefined;
}) {
  const drag = useDrag((fx, fy) => onChange({ ...hsva, s: fx, v: 1 - fy }), onStart, onEnd);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = moves[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onChange({ ...hsva, s: clamp01(hsva.s + d[0]), v: clamp01(hsva.v + d[1]) });
  };
  const s = Math.round(hsva.s * 100);
  const v = Math.round(hsva.v * 100);
  return (
    <div
      className="dp-color-picker__area"
      role="slider"
      tabIndex={0}
      aria-label={`${label} saturation and brightness`}
      aria-valuetext={`Saturation ${s}%, brightness ${v}%`}
      aria-valuenow={s}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ ["--dp-hue" as string]: hueColor }}
      onKeyDown={onKeyDown}
      {...drag}
    >
      <span
        className="dp-color-picker__thumb"
        style={{
          left: `${hsva.s * 100}%`,
          top: `${(1 - hsva.v) * 100}%`,
          background: cssColor(hsvToRgb({ ...hsva, a: 1 })),
        }}
      />
    </div>
  );
}

function ChannelSlider({
  label,
  value,
  max,
  unit,
  thumbColor,
  onChange,
  onStart,
  onEnd,
  className,
  style,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  thumbColor: string;
  onChange: (n: number) => void;
  onStart: (() => void) | undefined;
  onEnd: (() => void) | undefined;
  className: string;
  style?: React.CSSProperties;
}) {
  const drag = useDrag((fx) => onChange(fx * max), onStart, onEnd);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step;
    if (e.key === "PageUp") next = value + max / 10;
    if (e.key === "PageDown") next = value - max / 10;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(Math.min(max, Math.max(0, next)));
  };
  return (
    <div
      className={cx("dp-color-picker__slider", className)}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)}${unit}`}
      style={style}
      onKeyDown={onKeyDown}
      {...drag}
    >
      <span
        className="dp-color-picker__knob"
        style={{ left: `${(value / max) * 100}%`, background: thumbColor }}
      />
    </div>
  );
}
