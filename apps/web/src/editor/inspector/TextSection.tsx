/** The Text section: the layer's text style, typography, alignment and box sizing. */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { PropertySection, SegmentedControl } from "@drawpane/ui";
import { common } from "./fields";
import { TextStyleRow } from "./TextStyles";
import { TypographyFields } from "./TypographyFields";

export function TextSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  return (
    <PropertySection title="Text">
      <TextStyleRow editor={editor} nodes={nodes} />
      <TypographyFields editor={editor} nodes={nodes} />
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
    </PropertySection>
  );
}
