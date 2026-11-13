/**
 * Text: family, weight and italic, size, line height and letter spacing (px,
 * % or Auto, typed the way Figma takes them), horizontal and vertical
 * alignment, decoration, case and how the box sizes to its text.
 */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord, PropValues } from "@drawpane/model";
import {
  evaluateNumericInput,
  Icon,
  PropertyRow,
  PropertySection,
  SegmentedControl,
  Tooltip,
} from "@drawpane/ui";
import { useState } from "react";
import { common, Num, Select } from "./fields";

const FONTS = [
  "Instrument Sans",
  "Instrument Serif",
  "JetBrains Mono",
  "system-ui",
  "Arial",
  "Georgia",
  "Helvetica",
  "Times New Roman",
  "Courier New",
  "Verdana",
];

const WEIGHTS = [
  { value: 100, label: "Thin" },
  { value: 200, label: "Extra light" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Extra bold" },
  { value: 900, label: "Black" },
] as const;

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

export function TextSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const family = common(nodes, "fontFamily");
  const italic = common(nodes, "fontStyle") === "italic";
  const set = <
    K extends
      | "fontFamily"
      | "fontWeight"
      | "fontStyle"
      | "textAlign"
      | "textAlignVertical"
      | "textDecoration"
      | "textCase"
      | "textAutoResize"
      | "lineHeight"
      | "letterSpacing",
  >(
    prop: K,
    value: PropValues[K] | null,
    label: string,
  ) => editor.setProp(ids, prop, value, label);

  return (
    <PropertySection title="Text">
      <Select
        label="Font"
        value={family}
        options={[...new Set([...(family ? [family] : []), ...FONTS])].map((f) => ({
          value: f,
          label: f,
        }))}
        onChange={(v) => set("fontFamily", v, "Font")}
      />
      <div className="inspector__weight">
        <Select
          label="Weight"
          value={common(nodes, "fontWeight")}
          options={WEIGHTS}
          onChange={(v) => set("fontWeight", v, "Font weight")}
        />
        <Tooltip label="Italic" describe={false}>
          <button
            type="button"
            className="inspector__italic"
            aria-label="Italic"
            aria-pressed={italic}
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
      <div className="inspector__text-align">
        <SegmentedControl
          label="Text alignment"
          options={[
            { value: "left", icon: "align-left", title: "Align left" },
            { value: "center", icon: "align-center", title: "Align center" },
            { value: "right", icon: "align-right", title: "Align right" },
          ]}
          value={common(nodes, "textAlign") ?? ""}
          onChange={(v) => editor.setProp(ids, "textAlign", v, "Text alignment")}
        />
        <SegmentedControl
          label="Vertical alignment"
          options={[
            { value: "top", icon: "align-top", title: "Align top" },
            { value: "middle", icon: "align-middle", title: "Align middle" },
            { value: "bottom", icon: "align-bottom", title: "Align bottom" },
          ]}
          value={common(nodes, "textAlignVertical") ?? ""}
          onChange={(v) => editor.setProp(ids, "textAlignVertical", v, "Vertical alignment")}
        />
      </div>
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
      <SegmentedControl
        label="Text box sizing"
        options={[
          { value: "width", label: "Auto width" },
          { value: "height", label: "Auto height" },
          { value: "none", label: "Fixed" },
        ]}
        value={common(nodes, "textAutoResize") ?? ""}
        onChange={(v) => editor.setProp(ids, "textAutoResize", v, "Text sizing")}
      />
    </PropertySection>
  );
}
