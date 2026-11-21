import {
  cssFor,
  cssRule,
  type Editor,
  exportBounds,
  exportSvg,
  formatSvg,
  jsxFor,
  layerName,
  mediaUrl,
  tailwindFor,
  trackLabel,
  vectorApproximationNotes,
  vectorApproximations,
} from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Badge, IconButton, PropertySection, SegmentedControl } from "@drawpane/ui";
import { useEffect, useState } from "react";
import { modKey } from "../app/format";
import { imageRefs } from "./export-assets";
import { useDeferredDocVersion, useEditor, useEditorState } from "./hooks";
import { imagesFor } from "./media";

const KIND: Record<string, string> = {
  frame: "Frame",
  group: "Group",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  path: "Vector",
  text: "Text",
};

const n = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Inspect: the selection as a developer sees it. Measurements, the variables
 * behind each value, and copyable CSS, Tailwind, JSX or SVG. Free for everyone
 * who can open the file, viewers included.
 */
export function InspectPanel() {
  const editor = useEditor();
  const version = useDeferredDocVersion();
  const selection = useEditorState((s) => s.selection);
  const node = selection.length === 1 ? editor.doc.get(selection[0] as string) : undefined;
  const [format, setFormat] = useState<"css" | "tailwind" | "jsx" | "svg">("css");
  const svg = useSettledSvg(
    editor,
    format === "svg" && node && node.type !== "page" ? node.id : null,
    version,
  );

  if (!node || node.type === "page") {
    return (
      <div className="inspector">
        <h2 className="inspector__title">Inspect</h2>
        <p className="inspector__hint">
          Select a layer to see its measurements, the variables behind its values, and its code.
          Hold <kbd>Alt</kbd> and hover another layer to measure the distance between them.
        </p>
      </div>
    );
  }

  const code =
    format === "css"
      ? cssRule(editor.doc, node)
      : format === "tailwind"
        ? tailwindFor(editor.doc, node).join(" ")
        : format === "jsx"
          ? jsxFor(editor.doc, node)
          : (svg?.code ?? "");

  return (
    <div className="inspector inspect">
      <div className="inspect__head">
        <h2 className="inspector__title inspect__name">{layerName(node) || KIND[node.type]}</h2>
        <Badge>
          {getProp(node.props, "isComponent")
            ? "Component"
            : getProp(node.props, "instanceOf")
              ? "Instance"
              : (KIND[node.type] ?? "Layer")}
        </Badge>
      </div>
      <Summary node={node} />
      <PropertySection
        title="Code"
        actions={
          <IconButton
            icon="code"
            label="Copy code"
            shortcut={modKey("C")}
            onClick={async () => {
              await navigator.clipboard.writeText(code);
              editor.notify("Code copied.");
            }}
          />
        }
      >
        <SegmentedControl
          label="Code format"
          options={[
            { value: "css", label: "CSS" },
            { value: "tailwind", label: "Tailwind" },
            { value: "jsx", label: "JSX" },
            { value: "svg", label: "SVG" },
          ]}
          value={format}
          onChange={(v) => setFormat(v as typeof format)}
        />
        <pre className={`inspect__code${format === "svg" ? " inspect__code--markup" : ""}`}>
          <code>{code || "Nothing visible to draw."}</code>
        </pre>
        {svg?.notes.map((note) => (
          <p key={note} className="inspect__note">
            {note}
          </p>
        ))}
      </PropertySection>
    </div>
  );
}

/** How long the document has to be still before the SVG is written again. */
const SVG_SETTLE_MS = 200;

/**
 * The selected layer's SVG, written when it's asked for and again once edits
 * pause: a whole subtree's markup is too much to rebuild on every change
 * (each drag step, every collaborator's keystroke). A new layer, or opening
 * the tab, writes it at once.
 */
function useSettledSvg(
  editor: Editor,
  id: string | null,
  version: number,
): { code: string; notes: string[] } | null {
  const [state, setState] = useState<{ id: string; svg: { code: string; notes: string[] } } | null>(
    null,
  );
  const current = state && state.id === id ? state.svg : null;
  useEffect(() => {
    void version;
    if (!id) return;
    const write = () => {
      const node = editor.doc.get(id);
      if (node) setState({ id, svg: svgFor(editor, node) });
    };
    if (!current) {
      write();
      return;
    }
    const t = setTimeout(write, SVG_SETTLE_MS);
    return () => clearTimeout(t);
    // `current` only says whether there's anything on screen yet; it isn't a reason to rewrite.
  }, [editor, id, version]);
  return current;
}

/**
 * The layer as SVG markup, formatted for reading, and what to know about it:
 * images are linked to this file rather than embedded (exporting as SVG
 * embeds them), and background blur can't be expressed in SVG.
 */
function svgFor(editor: Editor, node: NodeRecord): { code: string; notes: string[] } {
  const bounds = exportBounds(editor.scene, [node.id]);
  if (!bounds) return { code: "", notes: [] };
  const cache = imagesFor(editor);
  // About as many characters as the panel shows on a line.
  const code = formatSvg(
    exportSvg(editor.scene, editor.measurer, [node.id], bounds, {
      images: (ref) => {
        const size = cache.natural(ref);
        return size ? { href: mediaUrl(ref), ...size } : null;
      },
    }),
    { width: 34 },
  );
  const notes: string[] = [];
  if (imageRefs(editor, [node.id]).size > 0)
    notes.push("Images link to this file. Export as SVG to embed them.");
  notes.push(...vectorApproximationNotes("svg", vectorApproximations(editor.doc, [node.id])));
  return { code, notes };
}

function Summary({ node }: { node: NodeRecord }) {
  const editor = useEditor();
  const p = node.props;
  const decls = cssFor(editor.doc, node);
  const token = (property: string) => decls.find((d) => d.property === property)?.token;
  const rows: Array<{ label: string; value: string; token?: string | undefined }> = [];
  const sizing = (axis: "sizingH" | "sizingV") => {
    const s = getProp(p, axis);
    return s === "fixed" ? "" : ` · ${s}`;
  };
  if (node.type !== "group") {
    rows.push({
      label: "Size",
      value: `${n(getProp(p, "width"))} × ${n(getProp(p, "height"))}${sizing("sizingH")}${sizing("sizingV")}`,
    });
  } else {
    const b = editor.scene.bounds(node.id);
    if (b) rows.push({ label: "Size", value: `${n(b.width)} × ${n(b.height)}` });
  }
  if (node.type === "frame" && getProp(p, "layoutMode") !== "none") {
    const mode = getProp(p, "layoutMode");
    if (mode === "grid") {
      const columns = getProp(p, "gridColumns");
      const rowTracks = getProp(p, "gridRows");
      rows.push({ label: "Layout", value: "Grid" });
      rows.push({
        label: "Columns",
        value: (columns.length > 0 ? columns : [{ unit: "fr", value: 1 } as const])
          .map(trackLabel)
          .join(" "),
      });
      if (rowTracks.length > 0)
        rows.push({ label: "Rows", value: rowTracks.map(trackLabel).join(" ") });
      rows.push({
        label: "Column gap",
        value: n(getProp(p, "gap")),
        token: token("column-gap") ?? token("gap"),
      });
      rows.push({
        label: "Row gap",
        value: n(getProp(p, "rowGap")),
        token: token("row-gap") ?? token("gap"),
      });
    } else {
      const wrap = getProp(p, "layoutWrap");
      rows.push({ label: "Layout", value: `Flex ${mode}${wrap ? ", wrap" : ""}` });
      // Wrapping splits `gap` into row-gap and column-gap when they differ.
      const along = mode === "row" ? "column-gap" : "row-gap";
      const across = mode === "row" ? "row-gap" : "column-gap";
      rows.push({ label: "Gap", value: n(getProp(p, "gap")), token: token(along) ?? token("gap") });
      if (wrap)
        rows.push({
          label: "Line gap",
          value: n(getProp(p, "rowGap")),
          token: token(across) ?? token("gap"),
        });
    }
    const pads = [
      getProp(p, "paddingTop"),
      getProp(p, "paddingRight"),
      getProp(p, "paddingBottom"),
      getProp(p, "paddingLeft"),
    ];
    rows.push({
      label: "Padding",
      value: pads.every((v) => v === pads[0]) ? n(pads[0] ?? 0) : pads.map(n).join(" "),
      token: token("padding"),
    });
  }
  if ((node.type === "frame" || node.type === "rect") && getProp(p, "cornerRadius") > 0) {
    rows.push({
      label: "Radius",
      value: n(getProp(p, "cornerRadius")),
      token: token("border-radius"),
    });
  }
  if ((node.type === "frame" || node.type === "rect") && getProp(p, "cornerSmoothing") > 0) {
    // No CSS for it: shown so a developer knows the corners aren't plain circles.
    rows.push({
      label: "Corner smoothing",
      value: `${Math.round(getProp(p, "cornerSmoothing") * 100)}%`,
    });
  }
  const fill = getProp(p, "fills").find((f) => f.type === "solid" && f.visible !== false);
  if (fill?.type === "solid") {
    rows.push({
      label: node.type === "text" ? "Color" : "Fill",
      value: fill.color.toLowerCase(),
      token: token(node.type === "text" ? "color" : "background-color") ?? token("background"),
    });
  }
  if (getProp(p, "opacity") < 1)
    rows.push({
      label: "Opacity",
      value: `${Math.round(getProp(p, "opacity") * 100)}%`,
      token: token("opacity"),
    });
  if (node.type === "text") {
    const styleId = getProp(p, "textStyle");
    const style = styleId ? editor.doc.get(styleId) : undefined;
    if (style)
      rows.push({ label: "Text style", value: getProp(style.props, "name") || "Text style" });
    rows.push({
      label: "Font",
      value: `${getProp(p, "fontFamily")} ${getProp(p, "fontWeight")}`,
      token: token("font-family"),
    });
    rows.push({ label: "Size", value: n(getProp(p, "fontSize")), token: token("font-size") });
  }
  return (
    <dl className="inspect__summary">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`} className="inspect__row">
          <dt>{row.label}</dt>
          <dd>
            {row.token ? (
              <>
                <span className="inspect__token">{row.token}</span>
                <span className="inspect__sep"> · </span>
              </>
            ) : null}
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
