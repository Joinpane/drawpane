/**
 * The Text section: the layer's text style, typography, alignment, box
 * sizing, paragraph spacing and truncation. Typography shows `views` (see `textViews`): the selected
 * characters while editing, every look in the layer otherwise.
 */
import type { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { PropertyRow, PropertySection, SegmentedControl } from "@drawpane/ui";
import { common, Num, Select } from "./fields";
import { TextStyleRow } from "./TextStyles";
import { TypographyFields } from "./TypographyFields";

/** At most this many lines, the last ending in "…". */
const TRUNCATE = [
  { value: "off", label: "All lines" },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    value: String(n),
    label: `Max ${n} ${n === 1 ? "line" : "lines"}`,
  })),
];

export function TextSection({
  editor,
  nodes,
  views = nodes,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  views?: NodeRecord[];
}) {
  const ids = nodes.map((n) => n.id);
  // undefined: the layers differ.
  const lines = nodes.map((n) => getProp(n.props, "maxLines"));
  const truncation = lines.every((l) => l === lines[0]) ? lines[0] : undefined;
  return (
    <PropertySection title="Text">
      <TextStyleRow editor={editor} nodes={nodes} />
      <TypographyFields editor={editor} nodes={views} />
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
      <PropertyRow>
        <Num
          editor={editor}
          nodes={nodes}
          prop="paragraphSpacing"
          label="¶"
          ariaLabel="Paragraph spacing"
          min={0}
        />
        <Select<string>
          label="Truncate"
          value={truncation === undefined ? null : truncation === null ? "off" : String(truncation)}
          mixed={truncation === undefined}
          options={TRUNCATE}
          onChange={(v) =>
            editor.setProp(ids, "maxLines", v === "off" ? null : Number(v), "Truncate text")
          }
        />
      </PropertyRow>
    </PropertySection>
  );
}
