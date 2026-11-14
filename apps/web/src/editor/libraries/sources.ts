/**
 * A library publish's snapshot, loaded once (docs/decisions/0010-team-libraries.md):
 * a read-only editor holding the library file as it was published, to
 * preview its components and copy them from. Snapshots never change, so
 * each is kept for the session.
 */
import { Editor, type LibraryRef, type TextMeasurer } from "@drawpane/editor";
import type { LibraryPublish } from "@drawpane/model";
import { api } from "../../api/client";

const loaded = new Map<string, Promise<Editor>>();
const ready = new Map<string, Editor>();

/** The publish's snapshot, as a read-only editor (loaded the first time it's asked for). */
export function librarySource(publish: LibraryPublish, measurer: TextMeasurer): Promise<Editor> {
  let source = loaded.get(publish.id);
  if (!source) {
    source = api.versionNodes(publish.fileId, publish.versionId).then((nodes) => {
      const editor = new Editor({ measurer });
      editor.loadStatic(nodes);
      ready.set(publish.id, editor);
      return editor;
    });
    // A failed load is tried again next time.
    source.catch(() => loaded.delete(publish.id));
    loaded.set(publish.id, source);
  }
  return source;
}

/** A snapshot already loaded, for a drop on the canvas (which can't wait). */
export function loadedSource(publishId: string): Editor | null {
  return ready.get(publishId) ?? null;
}

/** How a file refers to a library, at a publish. */
export function refOf(publish: LibraryPublish): LibraryRef {
  return { fileId: publish.fileId, name: publish.fileName, publishId: publish.id };
}

/** What's dragged from a library tile onto the canvas. */
export const LIBRARY_DRAG_MIME = "application/x-drawpane-library-component";

export interface LibraryDrag {
  readonly publishId: string;
  readonly fileId: string;
  readonly name: string;
  readonly assetId: string;
}
