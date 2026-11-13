/**
 * Comment state for one open file. Threads come from the REST API and are
 * patched by `comments` messages the FileRoom relays, so every tab sees a
 * change as soon as it's written. UI state (which thread is open, the
 * draft, the panel's filter) lives here too, outside the editor engine.
 */
import { Store } from "@drawpane/editor";
import type {
  CommentAnchor,
  CommentEvent,
  CommentPerson,
  CommentThread,
  ServerMessage,
} from "@drawpane/model";
import { api } from "../../api/client";

export type CommentFilter = "open" | "mine" | "resolved";
export type CommentScope = "page" | "all";

export interface CommentDraft {
  readonly pageId: string;
  readonly anchor: CommentAnchor;
  readonly text: string;
}

export interface CommentsState {
  readonly threads: ReadonlyMap<string, CommentThread>;
  readonly loaded: boolean;
  /** Set when the list couldn't load; the panel shows it. */
  readonly error: string | null;
  /** The thread whose popover is open. */
  readonly openId: string | null;
  /** A new pin waiting for its first message. */
  readonly draft: CommentDraft | null;
  readonly panelOpen: boolean;
  readonly filter: CommentFilter;
  readonly scope: CommentScope;
}

export class CommentStore {
  readonly state = new Store<CommentsState>({
    threads: new Map(),
    loaded: false,
    error: null,
    openId: null,
    draft: null,
    panelOpen: false,
    filter: "open",
    scope: "page",
  });
  #loads = 0;

  constructor(
    readonly fileId: string,
    /** The signed-in person, for "Mine" and author-only actions. */
    public me: CommentPerson | null = null,
  ) {}

  get s(): CommentsState {
    return this.state.get();
  }

  #base(): string {
    return `/files/${encodeURIComponent(this.fileId)}/comments`;
  }

  /** Fetches every thread. Called on open and after each reconnect, which may have missed events. */
  async load(): Promise<void> {
    const load = ++this.#loads;
    try {
      const { threads } = await api.get<{ threads: CommentThread[] }>(this.#base());
      if (load !== this.#loads) return;
      const next = new Map(threads.map((t) => [t.id, t]));
      const { openId } = this.s;
      this.state.set({
        threads: next,
        loaded: true,
        error: null,
        ...(openId && !next.has(openId) ? { openId: null } : {}),
      });
    } catch (error) {
      if (load !== this.#loads) return;
      this.state.set({
        loaded: true,
        error: error instanceof Error ? error.message : "Couldn't load comments. Try again.",
      });
    }
  }

  /** Feed every server message here; comment events patch the list. */
  receive(message: ServerMessage): void {
    if (message.t === "comments") this.apply(message.event);
  }

  apply(event: CommentEvent): void {
    if (event.kind === "thread") this.#upsert(event.thread);
    else this.#remove(event.threadId);
  }

  #upsert(thread: CommentThread): void {
    const current = this.s.threads.get(thread.id);
    // Events and responses can cross; keep the newest.
    if (current && current.updatedAt > thread.updatedAt) return;
    const threads = new Map(this.s.threads);
    threads.set(thread.id, thread);
    this.state.set({ threads });
  }

  #remove(threadId: string): void {
    if (!this.s.threads.has(threadId)) return;
    const threads = new Map(this.s.threads);
    threads.delete(threadId);
    this.state.set({ threads, ...(this.s.openId === threadId ? { openId: null } : {}) });
  }

  // -------------------------------------------------------------------------
  // Writes. Each one patches the list from the response at once; the room's
  // relay brings the same thread to everyone else.

  async create(draft: CommentDraft, body: string, mentions: readonly string[]) {
    const { thread } = await api.post<{ thread: CommentThread }>(this.#base(), {
      pageId: draft.pageId,
      x: draft.anchor.x,
      y: draft.anchor.y,
      nodeId: draft.anchor.nodeId,
      offset: draft.anchor.offset,
      body,
      mentions,
    });
    this.#upsert(thread);
    this.state.set({ draft: null, openId: thread.id });
    return thread;
  }

  async reply(threadId: string, body: string, mentions: readonly string[]) {
    const { thread } = await api.post<{ thread: CommentThread }>(
      `${this.#base()}/${threadId}/replies`,
      { body, mentions },
    );
    this.#upsert(thread);
    return thread;
  }

  async edit(threadId: string, commentId: string, body: string, mentions: readonly string[]) {
    const { thread } = await api.patch<{ thread: CommentThread }>(
      `${this.#base()}/${threadId}/messages/${commentId}`,
      { body, mentions },
    );
    this.#upsert(thread);
    return thread;
  }

  async setResolved(threadId: string, resolved: boolean) {
    const { thread } = await api.patch<{ thread: CommentThread }>(`${this.#base()}/${threadId}`, {
      resolved,
    });
    this.#upsert(thread);
    return thread;
  }

  /**
   * Moves a thread's pin. The pin moves at once; if the server refuses, it
   * goes back and the error is thrown for the caller to show.
   */
  async move(threadId: string, anchor: CommentAnchor) {
    const before = this.s.threads.get(threadId);
    if (!before) return;
    this.#replace({ ...before, anchor });
    try {
      const { thread } = await api.patch<{ thread: CommentThread }>(`${this.#base()}/${threadId}`, {
        anchor: { x: anchor.x, y: anchor.y, nodeId: anchor.nodeId, offset: anchor.offset },
      });
      this.#replace(thread);
      return thread;
    } catch (error) {
      const now = this.s.threads.get(threadId);
      // Only undo our own optimistic move, not something newer.
      if (now && now.anchor === anchor) this.#replace(before);
      throw error;
    }
  }

  /** Puts a thread in the list whatever its timestamp (moves don't change it). */
  #replace(thread: CommentThread): void {
    const threads = new Map(this.s.threads);
    threads.set(thread.id, thread);
    this.state.set({ threads });
  }

  async deleteMessage(threadId: string, commentId: string) {
    const result = await api.delete<{ threadDeleted: boolean; thread?: CommentThread }>(
      `${this.#base()}/${threadId}/messages/${commentId}`,
    );
    if (result.threadDeleted) this.#remove(threadId);
    else if (result.thread) this.#upsert(result.thread);
  }

  async deleteThread(threadId: string) {
    await api.delete(`${this.#base()}/${threadId}`);
    this.#remove(threadId);
  }

  // -------------------------------------------------------------------------
  // UI

  open(threadId: string): void {
    this.state.set({ openId: threadId, draft: null });
  }

  close(): void {
    this.state.set({ openId: null });
  }

  startDraft(pageId: string, anchor: CommentAnchor): void {
    this.state.set({ draft: { pageId, anchor, text: "" }, openId: null });
  }

  setDraftText(text: string): void {
    const { draft } = this.s;
    if (draft) this.state.set({ draft: { ...draft, text } });
  }

  cancelDraft(): void {
    this.state.set({ draft: null });
  }

  setPanel(panelOpen: boolean): void {
    this.state.set({ panelOpen });
  }

  setFilter(filter: CommentFilter): void {
    this.state.set({ filter });
  }

  setScope(scope: CommentScope): void {
    this.state.set({ scope });
  }
}

/** True when the thread involves `me`: started, replied to, or mentioned. */
export function involves(thread: CommentThread, me: string | null): boolean {
  if (!me) return false;
  if (thread.author?.id === me) return true;
  return thread.messages.some(
    (m) => m.author?.id === me || m.mentions.some((person) => person.id === me),
  );
}

export function matchesFilter(
  thread: CommentThread,
  filter: CommentFilter,
  me: string | null,
): boolean {
  if (filter === "resolved") return thread.resolvedAt !== null;
  if (thread.resolvedAt !== null) return false;
  return filter === "open" || involves(thread, me);
}

/** Most recent activity first. */
export function byRecency(a: CommentThread, b: CommentThread): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);
}
