import { xrayFrames } from "@drawpane/editor";
import { Kbd } from "@drawpane/ui";
import { isMac } from "../app/format";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { useUi } from "./ui-state";

/**
 * What the X-ray colours mean, above the zoom bar while X-ray is showing a
 * frame: padding, gaps (and that they drag), and how to get an explanation.
 */
export function XrayLegend() {
  const editor = useEditor();
  useDocVersion();
  const xray = useEditorState((s) => s.xray);
  // Re-read the frames as the selection and hover move.
  useEditorState((s) => s.selection);
  useEditorState((s) => s.hover);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const single = useEditorState((s) => s.selection.length === 1);
  const pinned = useUi(editor, (ui) => ui.xrayPinned);
  if (!xray || xrayFrames(editor).length === 0) return null;
  const alt = isMac() ? "⌥" : "Alt";
  return (
    <aside className="xray-legend pane" aria-label="Layout X-ray">
      <span className="xray-legend__item">
        <span className="xray-legend__swatch" data-kind="padding" />
        Padding
      </span>
      <span className="xray-legend__item">
        <span className="xray-legend__swatch" data-kind="gap" />
        {canEdit ? "Gap · drag to change" : "Gap"}
      </span>
      <span className="xray-legend__item">
        {pinned ? (
          "X-ray stays on"
        ) : (
          <>
            <Kbd keys={[alt]} /> held for X-ray
          </>
        )}
      </span>
      {single ? (
        <span className="xray-legend__item">
          <Kbd keys={[alt, "E"]} /> explain
        </span>
      ) : null}
    </aside>
  );
}
