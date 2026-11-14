/**
 * Typography fields: family, weight and italic, size, line height and
 * letter spacing (px, % or Auto, typed the way Figma takes them), decoration
 * and case. Shared by text layers and the text styles they follow.
 */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord, PropValues } from "@drawpane/model";
import { evaluateNumericInput, Icon, PropertyRow, Tooltip } from "@drawpane/ui";
import { useState } from "react";
import { type FontFamily, fonts, WEIGHT_NAMES } from "../../fonts/fonts";
import { FontPicker, useFonts } from "./FontPicker";
import { common, Num, Select } from "./fields";

/**
 * The weights a family offers (every hundred across a variable font's
 * range), plus the current one if the family lacks it, so it still shows.
 */
function weightOptions(info: FontFamily | null, current: number | null) {
  let weights: number[] = info
    ? info.variable
      ? [100, 200, 300, 400, 500, 600, 700, 800, 900].filter(
          (w) => w >= (info.weights[0] ?? 100) && w <= (info.weights.at(-1) ?? 900),
        )
      : [...new Set([...info.weights, ...info.italics])].sort((a, b) => a - b)
    : [100, 200, 300, 400, 500, 600, 700, 800, 900];
  if (weights.length === 0) weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  if (current !== null && !weights.includes(current))
    weights = [...weights, current].sort((a, b) => a - b);
  return weights.map((value) => ({
    value,
    label: `${WEIGHT_NAMES[value] ?? value}${info && !info.variable && !info.weights.includes(value) && !info.italics.includes(value) ? " (missing)" : ""}`,
  }));
}

type LineHeight = PropValues["lineHeight"];
type LetterSpacing = PropValues["letterSpacing"];

/** "Auto", "24", "24px" or "150%" → a line height; null for anything else. */
export function parseLineHeight(text: string): LineHeight | null {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "auto") return { unit: "auto" };
  if (t.endsWith("%")) {
    const n = evaluateNumericInput(t.slice(0, -1));
    return n !== null && n >= 0 ? { unit: "percent", value: Math.round(n * 100) / 100 } : null;
  }
  const n = evaluateNumericInput(t);
  return n !== null && n >= 0 ? { unit: "px", value: Math.round(n * 100) / 100 } : null;
}

/** "0", "-0.5px" or "2%" → a letter spacing; null for anything else. */
export function parseLetterSpacing(text: string): LetterSpacing | null {
  const t = text.trim().toLowerCase();
  if (t.endsWith("%")) {
    const n = evaluateNumericInput(t.slice(0, -1));
    return n !== null ? { unit: "percent", value: Math.round(n * 100) / 100 } : null;
  }
  const n = evaluateNumericInput(t || "0");
  return n !== null ? { unit: "px", value: Math.round(n * 100) / 100 } : null;
}

function formatLineHeight(lh: LineHeight | null): string {
  if (!lh) return "";
  if (lh.unit === "auto") return "Auto";
  return lh.unit === "percent" ? `${lh.value}%` : `${lh.value}`;
}

function formatLetterSpacing(ls: LetterSpacing | null): string {
  if (!ls) return "";
  return ls.unit === "percent" ? `${ls.value}%` : `${ls.value}`;
}

/** A text input for values with units, committed on Enter or blur. */
function UnitField({
  icon,
  label,
  value,
  parse,
  onCommit,
}: {
  icon: "line-height" | "letter-spacing";
  label: string;
  value: string;
  parse: (text: string) => unknown;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    if (parse(text) !== null && text.trim() !== value) onCommit(text);
    setDraft(null);
  };
  return (
    <span className="dp-field">
      <span className="dp-field__label" aria-hidden="true">
        <Icon name={icon} size={12} />
      </span>
      <input
        className="dp-field__input"
        aria-label={label}
        placeholder="Mixed"
        value={draft ?? value}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}

/**
 * The typography a text style shares with its layers: font, weight, italic,
 * size, line height, letter spacing, decoration and case. Used for text
 * layers and for editing a style itself.
 */
export function TypographyFields({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const family = common(nodes, "fontFamily");
  const italic = common(nodes, "fontStyle") === "italic";
  useFonts();
  const info = family ? fonts.get(family) : null;
  const set = <
    K extends
      | "fontWeight"
      | "fontStyle"
      | "textDecoration"
      | "textCase"
      | "lineHeight"
      | "letterSpacing",
  >(
    prop: K,
    value: PropValues[K] | null,
    label: string,
  ) => editor.setProp(ids, prop, value, label);

  return (
    <>
      <FontPicker editor={editor} nodes={nodes} />
      <div className="inspector__weight">
        <Select
          label="Weight"
          value={common(nodes, "fontWeight")}
          options={weightOptions(info, common(nodes, "fontWeight"))}
          onChange={(v) => set("fontWeight", v, "Font weight")}
        />
        <Tooltip label="Italic" describe={false}>
          <button
            type="button"
            className="inspector__italic"
            aria-label="Italic"
            aria-pressed={italic}
            disabled={
              !italic &&
              info !== null &&
              info.italics.length === 0 &&
              !info.variable &&
              info.source !== "system"
            }
            onClick={() =>
              set("fontStyle", italic ? null : "italic", italic ? "Upright" : "Italic")
            }
          >
            <Icon name="italic" size={16} />
          </button>
        </Tooltip>
        <Num
          editor={editor}
          nodes={nodes}
          prop="fontSize"
          label="Aa"
          ariaLabel="Font size"
          min={1}
        />
      </div>
      <PropertyRow>
        <UnitField
          icon="line-height"
          label="Line height"
          value={formatLineHeight(common(nodes, "lineHeight"))}
          parse={parseLineHeight}
          onCommit={(text) => {
            const lh = parseLineHeight(text);
            if (lh) set("lineHeight", lh.unit === "auto" ? null : lh, "Line height");
          }}
        />
        <UnitField
          icon="letter-spacing"
          label="Letter spacing"
          value={formatLetterSpacing(common(nodes, "letterSpacing"))}
          parse={parseLetterSpacing}
          onCommit={(text) => {
            const ls = parseLetterSpacing(text);
            if (ls) set("letterSpacing", ls.value === 0 ? null : ls, "Letter spacing");
          }}
        />
      </PropertyRow>
      <PropertyRow>
        <Select
          label="Decoration"
          value={common(nodes, "textDecoration")}
          options={[
            { value: "none", label: "No decoration" },
            { value: "underline", label: "Underline" },
            { value: "strikethrough", label: "Strikethrough" },
          ]}
          onChange={(v) => set("textDecoration", v === "none" ? null : v, "Text decoration")}
        />
        <Select
          label="Case"
          value={common(nodes, "textCase")}
          options={[
            { value: "none", label: "As typed" },
            { value: "upper", label: "UPPERCASE" },
            { value: "lower", label: "lowercase" },
            { value: "title", label: "Title Case" },
          ]}
          onChange={(v) => set("textCase", v === "none" ? null : v, "Text case")}
        />
      </PropertyRow>
    </>
  );
}
