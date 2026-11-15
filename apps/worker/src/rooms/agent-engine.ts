/**
 * The headless engine (decision 0021): an `Editor` inside the FileRoom that
 * runs agent tools when no open editor does. It is the same editor the
 * browser runs, with the Worker's text measurer, so a tool's edit gets the
 * same fix-ups (text sizing, auto layout, instances, variables) as a
 * person's.
 *
 * One editor stays warm per room: it follows every transaction the room
 * commits, and is rebuilt from the room's nodes when it falls out of step.
 * A run collects the operations the editor's sync engine queued (it never
 * connects, so everything it commits waits there) and hands them to the
 * room, which commits them as one transaction.
 */
import {
  Editor,
  type FrameClock,
  findTool,
  runTool,
  type TextFace,
  ToolFailure,
  type ToolResult,
  textFaces,
} from "@drawpane/editor";
import type { NodeRecord, Op } from "@drawpane/model";
import type { HeadlessMeasurer } from "../agent/measurer";

/** Nothing animates in a Worker. */
const NO_FRAMES: FrameClock = { request: () => 0, cancel: () => {} };

export interface EngineRun {
  readonly result: ToolResult;
  /** The operations the tool made, fix-ups included: what the room commits. Empty for a read. */
  readonly ops: Op[];
}

export class AgentEngine {
  readonly #measurer: HeadlessMeasurer;
  #editor: Editor | null = null;
  /** The room revision the warm editor shows. */
  #revn = -1;

  constructor(measurer: HeadlessMeasurer) {
    this.#measurer = measurer;
  }

  get warm(): boolean {
    return this.#editor !== null;
  }

  /**
   * The editor at the room's revision `revn`, kept warm or built from `read()`
   * when cold, out of step, or holding a different number of nodes than the
   * room (a sign it drifted).
   */
  editorAt(revn: number, count: number, read: () => NodeRecord[]): Editor {
    const warm = this.#editor;
    if (warm && this.#revn === revn && warm.doc.size === count) return warm;
    const editor = new Editor({
      measurer: this.#measurer,
      clientId: "agent",
      frames: NO_FRAMES,
      reducedMotion: () => true,
    });
    editor.doc.reset(read());
    editor.state.set({ role: "editor", status: "live" });
    this.#editor = editor;
    this.#revn = revn;
    return editor;
  }

  /** Follows a transaction the room committed at `revn`; lets go of the editor when it can't. */
  follow(ops: readonly Op[], revn: number): void {
    const editor = this.#editor;
    if (!editor) return;
    if (revn !== this.#revn + 1) {
      this.drop();
      return;
    }
    try {
      editor.doc.apply(ops);
      this.#revn = revn;
    } catch {
      this.drop();
    }
  }

  /** The engine's own run was committed at `revn`: its editor already shows it. */
  committed(revn: number): void {
    if (this.#editor) this.#revn = revn;
  }

  drop(): void {
    this.#editor = null;
    this.#revn = -1;
  }

  /** Faces the document's text is set in that the measurer hasn't loaded. */
  missingFaces(editor: Editor): TextFace[] {
    const missing = new Map<string, TextFace>();
    for (const node of editor.doc.nodes()) {
      if (node.type !== "text") continue;
      for (const face of textFaces(node))
        if (!this.#measurer.has(face))
          missing.set(`${face.family}\u0000${face.weight}\u0000${face.italic}`, face);
    }
    return [...missing.values()];
  }

  /** Loads fonts ahead of a run. */
  load(faces: readonly TextFace[]): Promise<void> {
    return this.#measurer.load(faces);
  }

  /**
   * Runs a tool on `editor` and takes the operations it made. A failure
   * throws, and when the failed tool had changed the editor, the editor is
   * let go (rebuilt next time), so nothing of it lingers. Something the
   * editor refused along the way (a notice) fails the whole call.
   */
  async run(editor: Editor, name: string, input: unknown): Promise<EngineRun> {
    const noticeBefore = editor.s.notice?.id ?? null;
    let result: ToolResult;
    try {
      result = await runTool(editor, name, input);
    } catch (error) {
      if (editor.sync.takeUnsent().length > 0) this.drop();
      throw error;
    } finally {
      editor.history.clear();
    }
    const ops = editor.sync.takeUnsent();
    const notice = editor.s.notice;
    if (notice && notice.id !== noticeBefore) {
      if (ops.length > 0) this.drop();
      throw new ToolFailure(notice.text);
    }
    if (findTool(name)?.level !== "write" && ops.length > 0) {
      // A read changed the document: it never should; don't keep what it did.
      this.drop();
      throw new Error(`${name} changed the document`);
    }
    return { result, ops };
  }

  /** Text faces in `ops` (new and restyled text) that the measurer hasn't loaded. */
  facesMissingFrom(editor: Editor, ops: readonly Op[]): TextFace[] {
    const ids = new Set(ops.filter((op) => op.op !== "delete").map((op) => op.id));
    const missing = new Map<string, TextFace>();
    for (const id of ids) {
      const node = editor.doc.get(id);
      if (node?.type !== "text") continue;
      for (const face of textFaces(node))
        if (!this.#measurer.has(face))
          missing.set(`${face.family}\u0000${face.weight}\u0000${face.italic}`, face);
    }
    return [...missing.values()];
  }
}
