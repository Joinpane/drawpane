/** Align and distribute: the selection to each other, or one layer to its frame. */
import type { AlignEdge, Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { IconButton, type IconName } from "@drawpane/ui";
import { shortcutFor } from "../actions";

/** Each button with the action whose shortcut its tooltip shows (the person's own, if changed). */
const ALIGN: ReadonlyArray<{ edge: AlignEdge; icon: IconName; label: string; action: string }> = [
  { edge: "left", icon: "align-left", label: "Align left", action: "arrange.alignLeft" },
  {
    edge: "center",
    icon: "align-center",
    label: "Align horizontal centers",
    action: "arrange.alignCenter",
  },
  { edge: "right", icon: "align-right", label: "Align right", action: "arrange.alignRight" },
  { edge: "top", icon: "align-top", label: "Align top", action: "arrange.alignTop" },
  {
    edge: "middle",
    icon: "align-middle",
    label: "Align vertical centers",
    action: "arrange.alignMiddle",
  },
  { edge: "bottom", icon: "align-bottom", label: "Align bottom", action: "arrange.alignBottom" },
];

export function AlignSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const single = nodes.length === 1 ? nodes[0] : undefined;
  // One layer aligns inside its frame; on the page there's nothing to align to.
  const canAlign =
    editor.canEdit && (nodes.length > 1 || editor.doc.get(single?.parent ?? "")?.type !== "page");
  const canDistribute = editor.canEdit && nodes.length > 2;
  return (
    <div className="inspector__align-bar" role="toolbar" aria-label="Align and distribute">
      {ALIGN.map((a) => (
        <IconButton
          key={a.edge}
          icon={a.icon}
          label={single ? `${a.label} to frame` : a.label}
          shortcut={shortcutFor(a.action)}
          disabled={!canAlign}
          onClick={() => editor.align(a.edge)}
        />
      ))}
      <span className="inspector__align-sep" aria-hidden="true" />
      <IconButton
        icon="distribute-horizontal"
        label="Distribute horizontal spacing"
        shortcut={shortcutFor("arrange.distributeHorizontal")}
        disabled={!canDistribute}
        onClick={() => editor.distribute("horizontal")}
      />
      <IconButton
        icon="distribute-vertical"
        label="Distribute vertical spacing"
        shortcut={shortcutFor("arrange.distributeVertical")}
        disabled={!canDistribute}
        onClick={() => editor.distribute("vertical")}
      />
    </div>
  );
}
