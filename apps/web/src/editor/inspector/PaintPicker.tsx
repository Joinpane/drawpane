/**
 * The fill and stroke picker: one popover, three tabs (Solid, Gradient,
 * Image). Tokens come before raw values so the design system stays the easy
 * path, then the colors this page already uses, then the contrast of the
 * color against what's behind the layer (WCAG), right where it's chosen.
 */
import type { Editor } from "@drawpane/editor";
import { listCollections, resolveVariable, variablesIn } from "@drawpane/editor";
import { type BindingKey, getProp, type NodeRecord, type Paint } from "@drawpane/model";
import {
  ColorPicker,
  contrastLevel,
  contrastRatio,
  Icon,
  IconButton,
  Popover,
  type PopoverSide,
  SegmentedControl,
} from "@drawpane/ui";
import { useEffect, useMemo, useState } from "react";
import { useEditorState } from "../hooks";
import { ImageTab } from "../ImageFill";
import { GradientEditor } from "./GradientEditor";
import {
  backdropOf,
  convertPaint,
  documentColors,
  type PaintKind,
  paintKind,
  rgbaOf,
  type SolidPaint,
  solidPickerValue,
  swatchCss,
  withPickerValue,
} from "./paint";

export interface PaintPickerProps {
  editor: Editor;
  anchor: HTMLElement;
  /** "Fill" or "Stroke": names the dialog and every control. */
  label: string;
  paint: Paint;
  /** The layers being edited: for contrast, token values and binding. */
  nodes: readonly NodeRecord[];
  /** Set when this is the first solid paint, which a color variable can drive. */
  bindKey?: BindingKey | undefined;
  /** Which tabs to offer. Strokes have no image. */
  kinds?: readonly PaintKind[];
  onChange: (next: Paint, label: string) => void;
  onClose: () => void;
  /** Where it opens beside the anchor. Default "left", beside the inspector. */
  side?: PopoverSide;
}

const KIND_LABEL: Record<PaintKind, string> = {
  solid: "Solid",
  gradient: "Gradient",
  image: "Image",
};

export function PaintPicker({
  editor,
  anchor,
  label,
  paint,
  nodes,
  bindKey,
  kinds = ["solid", "gradient", "image"],
  onChange,
  onClose,
  side = "left",
}: PaintPickerProps) {
  const kind = paintKind(paint);
  // The tab can run ahead of the paint: Image waits for a file before the paint changes.
  const [tab, setTab] = useState<PaintKind>(kind);
  useEffect(() => setTab(kind), [kind]);
  const begin = () => editor.beginGesture(`${label} color`);
  const end = () => editor.endGesture();

  return (
    <Popover
      anchor={anchor}
      label={`${label} paint`}
      side={side}
      className="paint-picker dp-root"
      onClose={onClose}
    >
      <div className="paint-picker__head">
        <SegmentedControl
          label="Paint type"
          options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          value={tab}
          onChange={(next) => {
            setTab(next);
            if (next === kind || next === "image") return;
            onChange(convertPaint(paint, next === "solid" ? "solid" : "linear"), "Paint type");
          }}
        />
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      {tab === "image" ? (
        <ImageTab editor={editor} paint={paint} onChange={onChange} />
      ) : paint.type === "solid" ? (
        <SolidTab
          editor={editor}
          label={label}
          paint={paint}
          nodes={nodes}
          bindKey={bindKey}
          onChange={onChange}
          onStart={begin}
          onEnd={end}
        />
      ) : paint.type === "image" ? null : (
        <GradientEditor
          label={label}
          paint={paint}
          onChange={onChange}
          onChangeStart={begin}
          onChangeEnd={end}
        />
      )}
    </Popover>
  );
}

function SolidTab({
  editor,
  label,
  paint,
  nodes,
  bindKey,
  onChange,
  onStart,
  onEnd,
}: {
  editor: Editor;
  label: string;
  paint: SolidPaint;
  nodes: readonly NodeRecord[];
  bindKey: BindingKey | undefined;
  onChange: (next: Paint, label: string) => void;
  onStart: () => void;
  onEnd: () => void;
}) {
  const pageId = useEditorState((s) => s.pageId);
  const colors = useMemo(() => documentColors(editor.doc, pageId), [editor, pageId]);
  const tokens = useMemo(
    () =>
      listCollections(editor.doc).flatMap((c) =>
        variablesIn(editor.doc, c.id).filter((v) => getProp(v.props, "variableType") === "color"),
      ),
    [editor],
  );
  const context = nodes[0];
  const bound = bindKey && context ? getProp(context.props, "bindings")[bindKey] : undefined;
  const set = (hex: string, name = `${label} color`) => onChange(withPickerValue(paint, hex), name);

  return (
    <div className="paint-picker__body">
      <ColorPicker
        label={label}
        value={solidPickerValue(paint)}
        onChange={(hex) => set(hex)}
        onChangeStart={onStart}
        onChangeEnd={onEnd}
      />
      {context ? <Contrast editor={editor} node={context} paint={paint} /> : null}
      {tokens.length > 0 ? (
        <section className="paint-picker__section" aria-label="Color tokens">
          <h3 className="paint-picker__heading">Tokens</h3>
          <div className="paint-picker__tokens">
            {tokens.map((variable) => {
              const value = resolveVariable(editor.doc, variable.id, context?.id);
              const hex = typeof value === "string" ? value : "#000000";
              const name = getProp(variable.props, "name");
              return (
                <button
                  key={variable.id}
                  type="button"
                  className="paint-picker__token"
                  aria-pressed={bound === variable.id}
                  title={bindKey ? `Use ${name}` : `Use ${name}'s color`}
                  onClick={() => {
                    if (bindKey && nodes.length > 0)
                      editor.bindVariable(
                        nodes.map((n) => n.id),
                        bindKey,
                        variable.id,
                      );
                    else set(hex, `${label} color`);
                  }}
                >
                  <span
                    className="paint-picker__token-swatch"
                    style={{ background: swatchCss({ type: "solid", color: hex }) }}
                  />
                  {name}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      {colors.length > 0 ? (
        <section className="paint-picker__section" aria-label="Colors on this page">
          <h3 className="paint-picker__heading">On this page</h3>
          <div className="paint-picker__swatches">
            {colors.map((hex) => (
              <button
                key={hex}
                type="button"
                className="paint-picker__swatch"
                style={{ background: swatchCss({ type: "solid", color: hex }) }}
                aria-label={`Use ${hex.slice(1).toUpperCase()}`}
                title={hex.slice(1).toUpperCase()}
                onClick={() => set(hex)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Contrast of the color against the layer's backdrop, with its WCAG level. */
function Contrast({
  editor,
  node,
  paint,
}: {
  editor: Editor;
  node: NodeRecord;
  paint: SolidPaint;
}) {
  const backdrop = backdropOf(editor.doc, node);
  if (!backdrop || paint.visible === false) return null;
  const ratio = contrastRatio(rgbaOf(paint.color, paint.opacity ?? 1), backdrop.color);
  const text = node.type === "text";
  const size = text ? getProp(node.props, "fontSize") : 0;
  const bold = text && getProp(node.props, "fontWeight") >= 700;
  // Large text is 18pt (24px), or 14pt (≈18.67px) bold. Shapes need 3:1 like large text.
  const large = !text || size >= 24 || (bold && size >= 18.66);
  const level = contrastLevel(ratio, large);
  const pass = level !== "Fail";
  return (
    <p
      className="paint-picker__contrast"
      data-pass={pass}
      title={`Against ${backdrop.name}. ${text ? (large ? "Large text" : "Body text") : "Graphics"} needs ${large ? "3:1" : "4.5:1"} for AA.`}
    >
      <span className="paint-picker__mark">
        <Icon name={pass ? "check" : "warning"} size={12} />
      </span>
      <span>
        Contrast <strong>{ratio.toFixed(2)}:1</strong>
      </span>
      <span className="paint-picker__level">
        {pass ? level : `Below ${large ? "3:1" : "4.5:1"}`}
      </span>
    </p>
  );
}
