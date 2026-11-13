import { cssFor, cssRule, jsxFor, tailwindFor } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Badge, IconButton, PropertySection, SegmentedControl } from "@drawpane/ui";
import { useState } from "react";
import { modKey } from "../app/format";
import { useDocVersion, useEditor, useEditorState } from "./hooks";

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
 * behind each value, and copyable CSS, Tailwind or JSX. Free for everyone who
 * can open the file, viewers included.
 */
export function InspectPanel() {
  const editor = useEditor();
  useDocVersion();
  const selection = useEditorState((s) => s.selection);
  const node = selection.length === 1 ? editor.doc.get(selection[0] as string) : undefined;
  const [format, setFormat] = useState<"css" | "tailwind" | "jsx">("css");

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
        : jsxFor(editor.doc, node);

  return (
    <div className="inspector inspect">
      <div className="inspect__head">
        <h2 className="inspector__title inspect__name">
          {getProp(node.props, "name") || KIND[node.type]}
        </h2>
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
          ]}
          value={format}
          onChange={(v) => setFormat(v as typeof format)}
        />
        <pre className="inspect__code" aria-label={`${format} code`}>
          <code>{code}</code>
        </pre>
      </PropertySection>
    </div>
  );
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
    rows.push({ label: "Layout", value: `Flex ${getProp(p, "layoutMode")}` });
    rows.push({ label: "Gap", value: n(getProp(p, "gap")), token: token("gap") });
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
