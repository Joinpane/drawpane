/**
 * Renders the open context menu (the canvas, a layer, a page) for whichever
 * editor is on screen: the live file, or a saved version (read-only, so its
 * menus only offer what doesn't edit).
 */
import type { Editor } from "@drawpane/editor";
import { ContextMenu } from "@drawpane/ui";
import type { ActionContext } from "./actions";
import { pasteFromClipboard } from "./media";
import { type MenuHost, menuFor } from "./menus";
import { uiFor, useUi } from "./ui-state";

export function ContextMenus({
  editor,
  ctx,
  fileId,
  commentsShown,
}: {
  editor: Editor;
  ctx: ActionContext;
  fileId: string;
  commentsShown: boolean;
}) {
  const request = useUi(editor, (ui) => ui.menu);
  if (!request) return null;
  const host: MenuHost = {
    ctx: { ...ctx, editor },
    commentsShown,
    pasteAt: (point) => {
      void pasteFromClipboard(editor, fileId, point).then((pasted) => {
        if (!pasted) editor.notify("The clipboard doesn't hold Drawpane layers or images.");
      });
    },
    renamePage: (pageId) => uiFor(editor).set({ renaming: pageId }),
  };
  const items = menuFor(host, request);
  if (items.length === 0) return null;
  const label =
    request.kind === "page" ? "Page" : editor.s.selection.length > 0 ? "Selection" : "Canvas";
  return (
    <ContextMenu
      // A new right-click opens a fresh menu where the pointer is.
      key={`${request.x},${request.y},${request.kind}`}
      at={request}
      items={items}
      label={`${label} actions`}
      onClose={() => uiFor(editor).set({ menu: null })}
    />
  );
}
