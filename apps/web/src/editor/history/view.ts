/**
 * Looking at an older version of a file.
 *
 * The version loads into its own read-only `Editor` (the preview), which the
 * canvas, layers and inspect panels render instead of the live one. The live
 * editor stays connected underneath, so nothing anyone does is missed, and
 * going back to now is instant. Page and camera follow you both ways, so the
 * version opens where you were looking and you come back to where you were.
 */
import { Editor, Interaction, Store } from "@drawpane/editor";
import type { NodeRecord, VersionInfo } from "@drawpane/model";

export interface VersionViewState {
  /** The version on screen, or null when looking at now. */
  readonly viewing: VersionInfo | null;
  /** A version that is loading; it replaces `viewing` once it arrives. */
  readonly loading: VersionInfo | null;
  readonly error: string | null;
}

export class VersionView {
  readonly preview: Editor;
  readonly interaction: Interaction;
  readonly state = new Store<VersionViewState>({ viewing: null, loading: null, error: null });
  readonly #live: Editor;
  readonly #load: (version: VersionInfo) => Promise<readonly NodeRecord[]>;
  /** Bumped on every show or leave, so a slow load can't land after you've moved on. */
  #token = 0;

  constructor(live: Editor, load: (version: VersionInfo) => Promise<readonly NodeRecord[]>) {
    this.#live = live;
    this.#load = load;
    this.preview = new Editor({ measurer: live.measurer });
    this.interaction = new Interaction(this.preview);
  }

  get s(): VersionViewState {
    return this.state.get();
  }

  /** The editor whose document is on screen. */
  get active(): Editor {
    return this.s.viewing ? this.preview : this.#live;
  }

  show = async (version: VersionInfo): Promise<void> => {
    if (this.s.viewing?.id === version.id && !this.s.loading) return;
    const token = ++this.#token;
    this.state.set({ loading: version, error: null });
    let nodes: readonly NodeRecord[];
    try {
      nodes = await this.#load(version);
    } catch (error) {
      if (token !== this.#token) return;
      this.state.set({
        loading: null,
        error: error instanceof Error ? error.message : "Couldn't load that version.",
      });
      return;
    }
    if (token !== this.#token) return;
    const entering = this.s.viewing === null;
    this.preview.loadStatic(nodes);
    if (entering) {
      this.preview.state.set({ selection: [], hover: null });
      follow(this.#live, this.preview);
    }
    this.state.set({ viewing: version, loading: null });
  };

  /** Back to now, at the page and place you were looking at in the version. */
  leave = (): void => {
    ++this.#token;
    if (this.s.viewing) follow(this.preview, this.#live);
    this.state.set({ viewing: null, loading: null, error: null });
  };
}

/** Puts `to` on `from`'s page and camera, when `to` has that page. */
function follow(from: Editor, to: Editor): void {
  const { pageId, camera, viewport, insets } = from.s;
  to.state.set({ viewport, insets });
  if (pageId && to.doc.has(pageId)) {
    if (to.s.pageId !== pageId) to.setPage(pageId);
    to.setCamera(camera);
  } else {
    requestAnimationFrame(() => to.zoomToFit());
  }
}
