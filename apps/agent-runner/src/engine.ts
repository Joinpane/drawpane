/**
 * The headless engine (decision 0021): an `Editor` in the agent runner
 * (decision 0033) that runs agent tools when no open editor does. It is the same editor the
 * browser runs, with the Worker's text measurer, so a tool's edit gets the
 * same fix-ups (text sizing, auto layout, instances, variables) as a
 * person's.
 *
 * One editor stays warm per file: it follows the transactions the room
 * logged since (the runner gets them with each call), and is rebuilt from a
 * snapshot of the file when it falls out of step.
 * Everything it keeps is counted in a meter as it's kept
 * (`agent-admission.ts`): built from pages of the room's rows, it's refused
 * partway (`AgentTooLarge`) when the file is more than it may hold, and a
 * warm one that grows past that is let go of, so the next call builds it
 * again and is refused.
 * A run collects the operations the editor's sync engine queued (it never
 * connects, so everything it commits waits there) and hands them back; the
 * main Worker has the room commit them as one transaction.
 */
import {
  Editor,
  type FrameClock,
  findTool,
  isHarfBuzzOutOfMemory,
  runTool,
  type TextFace,
  ToolFailure,
  type ToolResult,
  type ToolServices,
  textFaces,
} from "@drawpane/editor";
import {
  type BuildBudget,
  type CopiesFormat,
  isMainNode,
  type NodeRecord,
  type Op,
  ROOT_ID,
  slotBytes,
} from "@drawpane/model";
import {
  AGENT_MAX_HELD,
  AGENT_MAX_NODES,
  AgentTooLarge,
  agentMeter,
  asTooLarge,
  tooManyLayers,
} from "@drawpane/worker/src/rooms/agent-admission";
import type { HeadlessMeasurer } from "./measurer";

/**
 * Text whose fonts don't fit in HarfBuzz's capped memory (decision 0033).
 * The fonts loaded before still measure right; nothing was changed.
 */
export const TEXT_OUT_OF_MEMORY =
  "That text needs more memory for its fonts than agent tools have, and nothing was changed. Use fewer font families or weights, or work on a smaller part.";

/** Nothing animates in a Worker. */
const NO_FRAMES: FrameClock = { request: () => 0, cancel: () => {} };

export interface EngineRun {
  readonly result: ToolResult;
  /**
   * The operations the tool made, fix-ups included, as stored (override
   * records in a file with compact copies): what the room commits. Empty
   * for a read.
   */
  readonly ops: Op[];
}

export class AgentEngine {
  readonly #measurer: HeadlessMeasurer;
  #editor: Editor | null = null;
  /** The room revision the warm editor shows. */
  #revn = -1;
  /** What the warm editor's meter counts it holding. */
  #meter: BuildBudget | null = null;

  /** The most its editor may hold, as its meter counts it. */
  readonly #limit: number;

  /** `limit`: AGENT_MAX_HELD unless said (the memory check sets a lower one for a lower heap cap). */
  constructor(measurer: HeadlessMeasurer, { limit = AGENT_MAX_HELD }: { limit?: number } = {}) {
    this.#measurer = measurer;
    this.#limit = limit;
  }

  /** What lays text out here: the renderer measures with it too. */
  get measurer(): HeadlessMeasurer {
    return this.#measurer;
  }

  get warm(): boolean {
    return this.#editor !== null;
  }

  /** The room revision the warm editor shows; -1 when there's none. */
  get revn(): number {
    return this.#editor ? this.#revn : -1;
  }

  /** What the editor warm at `revn` holds, as its meter counts it; null when there's none. */
  heldAt(revn: number): number | null {
    return this.#editor && this.#revn === revn ? (this.#meter?.held ?? 0) : null;
  }

  /**
   * The editor at the room's revision `revn`, kept warm or built from
   * `read()` (stored as `copies`: decision 0029) when cold, out of step, or
   * holding a different number of stored nodes than the room (a sign it
   * drifted). `read` yields the room's nodes a page at a time; each is
   * counted in the meter as it's kept, and every copy layer as it's built,
   * so a file more than the editor may hold throws `AgentTooLarge` partway,
   * holding no more than the limit, and nothing is kept.
   */
  editorAt(
    revn: number,
    count: number,
    read: () => Iterable<NodeRecord>,
    copies: CopiesFormat = "materialized",
  ): Editor {
    const warm = this.#editor;
    if (warm && this.#revn === revn && warm.doc.storedSize === count && warm.doc.copies === copies)
      return warm;
    this.drop();
    const meter = agentMeter(this.#limit);
    const editor = new Editor({
      measurer: this.#measurer,
      clientId: "agent",
      frames: NO_FRAMES,
      reducedMotion: () => true,
    });
    try {
      editor.doc.resetStored(read(), copies, { meter });
      // Every copy layer built now, counted as it's built: the editor reads them all soon enough.
      const layers = editor.doc.size;
      if (layers > AGENT_MAX_NODES) throw new AgentTooLarge(tooManyLayers(layers));
    } catch (error) {
      throw asTooLarge(error, this.#limit) ?? error;
    }
    editor.state.set({ role: "editor", status: "live" });
    this.#editor = editor;
    this.#revn = revn;
    this.#meter = meter;
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
    // Copies it would add at the least, before building any: past the limit, let go at once.
    const meter = this.#meter;
    if (meter && meter.held + slotBytes(1) * copiesAdded(editor, ops) > meter.limit) {
      this.drop();
      return;
    }
    try {
      // The room committed it: applied as stored, however deep (decision 0026). Copy layers it
      // makes are built as it applies, refused (`BuildTooLarge`) past the meter's limit.
      editor.doc.applyStored(ops, { held: true });
      this.#revn = revn;
    } catch {
      this.drop();
      return;
    }
    this.#measure();
  }

  /** The engine's own run was committed at `revn`: its editor already shows it. */
  committed(revn: number): void {
    if (!this.#editor) return;
    this.#revn = revn;
    this.#measure();
  }

  /**
   * Lets the editor go when what it holds, as its meter counts it after a
   * change, is past the limit, or it presents more layers than agents
   * work on.
   */
  #measure(): void {
    const editor = this.#editor;
    if (!editor) return;
    try {
      // Builds any copy layer not built yet, each counted (and refused past the limit).
      if (this.#meter?.over || editor.doc.size > AGENT_MAX_NODES) this.drop();
    } catch {
      this.drop();
    }
  }

  drop(): void {
    this.#editor = null;
    this.#revn = -1;
    this.#meter = null;
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

  /** Loads fonts ahead of a run. Fonts that don't fit in HarfBuzz's memory fail it (`ToolFailure`). */
  async load(faces: readonly TextFace[]): Promise<void> {
    try {
      await this.#measurer.load(faces);
    } catch (error) {
      if (isHarfBuzzOutOfMemory(error)) throw new ToolFailure(TEXT_OUT_OF_MEMORY);
      throw error;
    }
  }

  /**
   * Runs a tool on `editor` and takes the operations it made. A failure
   * throws, and when the failed tool had changed the editor, the editor is
   * let go (rebuilt next time), so nothing of it lingers. Something the
   * editor refused along the way (a notice) fails the whole call.
   */
  async run(
    editor: Editor,
    name: string,
    input: unknown,
    services: ToolServices = {},
  ): Promise<EngineRun> {
    const noticeBefore = editor.s.notice?.id ?? null;
    let result: ToolResult;
    try {
      result = await runTool(editor, name, input, services);
    } catch (error) {
      const tooLarge = asTooLarge(error, this.#limit);
      // The meter stopped it: what the editor holds is past what it may, so it's let go of.
      if (editor.sync.takeUnsent().length > 0 || tooLarge) this.drop();
      // Text measured partway when HarfBuzz ran out: the editor's layout can't be trusted.
      if (isHarfBuzzOutOfMemory(error)) {
        this.drop();
        throw new ToolFailure(TEXT_OUT_OF_MEMORY);
      }
      throw tooLarge ?? error;
    } finally {
      editor.history.clear();
      // What the run kept (its own changes, copies it built) is counted: past the limit, let go.
      if (editor === this.#editor && this.#meter?.over) this.drop();
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

/**
 * The fewest copy layers following `ops` adds (compact copies): a layer
 * created inside a main gains a copy in each of its instances, at least.
 * Read before anything is applied, from the stored form.
 */
function copiesAdded(editor: Editor, ops: readonly Op[]): number {
  if (!editor.doc.compactCopies) return 0;
  const stored = editor.doc.storedReader();
  /** The nearest main `id` is in (itself included), as far as the root. */
  const mainOf = (id: string): string | null => {
    let at: NodeRecord | undefined = stored.get(id);
    while (at && at.id !== ROOT_ID) {
      const { id: here, parent } = at;
      if (isMainNode(at)) return here;
      at = stored.get(parent);
    }
    return null;
  };
  const instances = new Map<string, number>();
  let added = 0;
  for (const op of ops) {
    if (op.op !== "create" || op.type === "override") continue;
    const main = mainOf(op.parent);
    if (main === null) continue;
    let n = instances.get(main);
    if (n === undefined) {
      n = editor.doc.instanceRoots(main).length;
      instances.set(main, n);
    }
    added += n;
  }
  return added;
}
