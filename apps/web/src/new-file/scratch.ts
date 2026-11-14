/**
 * Building a file's first content in the browser, before the file exists:
 * a headless editor on a scratch document, measured with the real fonts, so
 * text sizes, auto layout and text styles come out exactly as the editor
 * makes them. The result is a list of nodes for the import endpoint.
 */
import { CanvasTextMeasurer, Editor } from "@drawpane/editor";
import { keyBetween, type NodeRecord, newId, ROOT_ID } from "@drawpane/model";

export interface Scratch {
  readonly editor: Editor;
  readonly pageId: string;
}

/** The family templates are set in; loaded before measuring so sizes are right. */
export const TEMPLATE_FONT = "Instrument Sans";

export async function scratchEditor(pageName = "Page 1"): Promise<Scratch> {
  await Promise.all(
    [400, 500, 600, 700].map((w) =>
      document.fonts.load(`${w} 16px "${TEMPLATE_FONT}"`).catch(() => []),
    ),
  );
  const editor = new Editor({ measurer: new CanvasTextMeasurer(), clientId: newId(8) });
  editor.state.set({ role: "editor" });
  const pageId = newId();
  editor.doc.apply([
    {
      op: "create",
      id: pageId,
      type: "page",
      parent: ROOT_ID,
      key: keyBetween(null, null),
      props: { name: pageName },
    },
  ]);
  editor.setPage(pageId);
  return { editor, pageId };
}

/** Another page in the scratch file, after the others. */
export function addPage(editor: Editor, name: string): string {
  const last = editor.doc.pageIds().at(-1);
  const id = newId();
  editor.doc.apply([
    {
      op: "create",
      id,
      type: "page",
      parent: ROOT_ID,
      key: keyBetween(last ? (editor.doc.get(last)?.key ?? null) : null, null),
      props: { name },
    },
  ]);
  return id;
}

/** Everything in the scratch file, ready to import. */
export function nodesOf(editor: Editor): NodeRecord[] {
  return [...editor.doc.nodes()];
}
