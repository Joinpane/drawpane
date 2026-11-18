/**
 * The agent runner for one file (decision 0033): the headless engine
 * (`AgentEngine`), its text measurer and the renderer behind
 * `AgentRunnerApi`. The `AgentRunner` Durable Object (`index.ts`) holds one
 * per file, and the main Worker calls it; it never calls the room.
 *
 * The file comes with each call (`AgentFileSource`): when the editor is warm,
 * the transactions logged since the revision it shows, which it follows;
 * when cold, a snapshot it builds the editor from, metered as it's built.
 * When what it got doesn't fit what it holds, it asks for the file again,
 * cold (`again`).
 *
 * It never commits. A write tool's run answers with the operations it made
 * and the revision it ran on; the main Worker hands those to the room and
 * tells the runner how the commit went (`committed`). Until then the editor
 * holds changes the file doesn't have yet, so the next run that finds them
 * there lets them go.
 */
import {
  type Doc,
  type DocReads,
  findTool,
  type HeadlessRenderer,
  ToolFailure,
  type ToolServices,
} from "@drawpane/editor";
import { type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import {
  AGENT_RUNNER_ACCEPTS,
  AGENT_RUNNER_V,
  AGENT_SCOPE_CAP,
  type AgentCommittedNote,
  type AgentFileSource,
  type AgentHeld,
  type AgentReads,
  type AgentRunAnswer,
  type AgentRunnerApi,
  type AgentRunRequest,
} from "@drawpane/worker/src/agent/runner-api";
import { AgentTooLarge } from "@drawpane/worker/src/rooms/agent-admission";
import {
  openSnapshot,
  openSnapshotStream,
  snapshotNodes,
} from "@drawpane/worker/src/rooms/snapshots";
import { AgentEngine, type EngineRun } from "./engine";
import type { Env } from "./env";
import { agentMeasurer, fileFontLoader } from "./harfbuzz";
import type { HeadlessMeasurer } from "./measurer";
import { headlessRenderer } from "./render";

const OUT_OF_STEP =
  "The agent runner was updated during that call, and changed nothing. Try again.";

/** Why a source couldn't be used: ask again cold, and from the room itself when `live`. */
class Again extends Error {
  constructor(readonly live = false) {
    super("again");
  }
}

/** Lets go of a snapshot stream the run didn't read to the end (the room keeps a copy for it). */
async function release(source: AgentFileSource): Promise<void> {
  if (source.kind === "snapshot") await source.body?.cancel().catch(() => {});
}

export class FileRunner implements AgentRunnerApi {
  readonly #env: Env;
  readonly #fileId: string;
  readonly #measurer: () => HeadlessMeasurer;
  #engine: AgentEngine | null = null;
  #rendering: Promise<HeadlessRenderer> | null = null;
  /** Calls one at a time, in the order made. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The run whose changes the editor holds, uncommitted, and the revision it ran on. */
  #pending: { runId: string; baseRevn: number } | null = null;
  /** The revision the editor's meter refused the file at, and why: asked again, refused at once. */
  #refusal: { revn: number; message: string } | null = null;
  /** How many times an editor was built from a snapshot (for tests: warm calls build none). */
  builds = 0;

  constructor(env: Env, fileId: string, measurer = () => agentMeasurer(env, fileId)) {
    this.#env = env;
    this.#fileId = fileId;
    this.#measurer = measurer;
  }

  async held(_fileId: string): Promise<AgentHeld> {
    return { v: AGENT_RUNNER_V, revn: this.#heldRevn() };
  }

  run(request: AgentRunRequest): Promise<AgentRunAnswer> {
    const next = this.#queue.then(() => this.#run(request));
    this.#queue = next.catch(() => {});
    return next;
  }

  async committed(note: AgentCommittedNote): Promise<void> {
    if (!AGENT_RUNNER_ACCEPTS.includes(note.v) || this.#pending?.runId !== note.runId) return;
    const { baseRevn } = this.#pending;
    this.#pending = null;
    const engine = this.#engine;
    if (!engine) return;
    // Landed right after the revision it ran on: the editor already shows the file as it is.
    if (note.revn === baseRevn + 1 && engine.heldAt(baseRevn) !== null) engine.committed(note.revn);
    else engine.drop();
  }

  async drop(_fileId: string): Promise<void> {
    this.forget();
  }

  /** Lets go of the editor, and the run it held. */
  forget(): void {
    this.#engine?.drop();
    this.#pending = null;
  }

  /** The revision the warm editor shows; null when cold or holding a run not committed yet. */
  #heldRevn(): number | null {
    if (this.#pending || !this.#engine?.warm) return null;
    return this.#engine.revn;
  }

  // ---------------------------------------------------------------------------

  async #run(request: AgentRunRequest): Promise<AgentRunAnswer> {
    if (!AGENT_RUNNER_ACCEPTS.includes(request.v)) {
      await release(request.source);
      return { ok: false, message: OUT_OF_STEP };
    }
    const tool = findTool(request.tool);
    if (!tool) {
      await release(request.source);
      return { ok: false, message: `There's no tool ${request.tool}.` };
    }
    const engine = this.#engineFor();
    // A run before this one whose commit it never heard about: the editor isn't the file.
    if (this.#pending) this.forget();
    const write = tool.level === "write";
    const { source } = request;
    try {
      const editor = await this.#editorAt(engine, source);
      // The fonts the file is set in, loaded before anything is measured (or drawn).
      if (write || request.tool === "export_image") {
        const missing = engine.missingFaces(editor);
        if (missing.length > 0) await engine.load(missing);
      }
      const services: ToolServices = write
        ? {}
        : {
            renderPng: async (id, options) =>
              (await this.#renderer(engine)).renderPng(editor.doc, id, options),
          };
      let run: EngineRun;
      // Where the tool and the layout it sets off read: with what it changed, the run's scope.
      const reads = write ? editor.doc.trackReads() : null;
      try {
        run = await engine.run(editor, request.tool, request.input, services);
      } finally {
        if (write) editor.doc.untrackReads();
      }
      // Text in a font not loaded yet: load it, and build again so it's measured right.
      if (write) {
        const fonts = engine.facesMissingFrom(editor, run.ops);
        if (fonts.length > 0) {
          engine.drop();
          await engine.load(fonts);
          return { ok: false, again: true };
        }
      }
      const runId = crypto.randomUUID();
      if (run.ops.length > 0) this.#pending = { runId, baseRevn: source.revn };
      const { data, image } = run.result;
      return {
        ok: true,
        runId,
        baseRevn: source.revn,
        ops: run.ops,
        reads: reads
          ? agentReads(editor.doc, reads, run.ops)
          : { units: [], lists: [], absent: [] },
        result: data ?? null,
        ...(image ? { image } : {}),
      };
    } catch (error) {
      if (error instanceof Again) {
        this.forget();
        return error.live ? { ok: false, again: true, live: true } : { ok: false, again: true };
      }
      if (error instanceof ToolFailure) return { ok: false, message: error.message };
      // Anything else is a bug: logged, and everything let go in case it was left half-done.
      console.error(`agent tool ${request.tool} failed`, error);
      this.forget();
      return {
        ok: false,
        message: `${request.tool} failed unexpectedly, and changed nothing. Try it another way, or in smaller steps.`,
      };
    } finally {
      // A stream not read to the end (a refusal, a failure) lets go of the room's copy.
      await release(source);
    }
  }

  /** The engine, made with the file's measurer the first time. */
  #engineFor(): AgentEngine {
    this.#engine ??= new AgentEngine(this.#measurer());
    return this.#engine;
  }

  /**
   * The editor at the source's revision: the warm one brought up to date
   * with the log, or one built from the snapshot, metered as it's built. A
   * file the meter stops partway is refused (`AgentTooLarge`), and the
   * refusal is kept for that revision, so asking again doesn't build it
   * again. What doesn't line up (`Again`) asks for the file again, cold.
   */
  async #editorAt(engine: AgentEngine, source: AgentFileSource) {
    if (this.#refusal?.revn === source.revn) throw new AgentTooLarge(this.#refusal.message);
    try {
      if (source.kind === "log") {
        // Its editor moved on, or went, since it said where it was.
        if (engine.heldAt(source.from) === null) throw new Again();
        this.#follow(engine, source.txns);
      } else {
        const records = await this.#snapshotRecords(source);
        engine.drop();
        this.builds++;
        engine.editorAt(source.at, records.length, () => records, source.copies);
        this.#follow(engine, source.txns);
      }
      // Built and followed to `revn`, with the room's count of stored nodes: else it drifted.
      const editor = engine.editorAt(
        source.revn,
        source.count,
        () => {
          throw new Again();
        },
        source.copies,
      );
      return editor;
    } catch (error) {
      if (error instanceof AgentTooLarge)
        this.#refusal = { revn: source.revn, message: error.message };
      throw error;
    }
  }

  /** Follows logged transactions in order; a gap, or one it can't apply, asks again. */
  #follow(engine: AgentEngine, txns: AgentFileSource["txns"]): void {
    for (const txn of txns) {
      engine.follow(JSON.parse(txn.ops) as Op[], txn.revn);
      if (engine.heldAt(txn.revn) === null) throw new Again();
    }
  }

  /** The snapshot's nodes, read to the end: from R2 (the saved version) or the room's stream. */
  async #snapshotRecords(
    source: Extract<AgentFileSource, { kind: "snapshot" }>,
  ): Promise<NodeRecord[]> {
    const opened = source.body
      ? await openSnapshotStream(source.body)
      : source.key
        ? await openSnapshot(this.#env.FILES, source.key)
        : null;
    const header = opened?.header;
    // Gone since (an expired version), or not the revision and form the room said: from the room.
    if (
      !opened ||
      header?.revn !== source.at ||
      (header.copies ?? "materialized") !== source.copies
    ) {
      await opened?.lines.return(undefined);
      if (source.body) throw new Error("The room's snapshot stream isn't the file it said.");
      throw new Again(true);
    }
    const records: NodeRecord[] = [];
    for await (const batch of snapshotNodes(opened))
      for (const record of batch) records.push(record);
    return records;
  }

  /** The renderer, made the first time something is drawn. */
  #renderer(engine: AgentEngine): Promise<HeadlessRenderer> {
    this.#rendering ??= headlessRenderer(
      this.#env,
      this.#fileId,
      engine.measurer,
      fileFontLoader(this.#env, this.#fileId),
    ).catch((error: unknown) => {
      this.#rendering = null;
      throw error;
    });
    return this.#rendering;
  }
}

export function agentReads(doc: Doc, reads: DocReads, ops: readonly Op[]): AgentReads {
  if (reads.all) return null;
  const made = new Set<string>();
  for (const op of ops) if (op.op === "create") made.add(op.id);
  const units = new Set<string>();
  const lists = new Set<string>();
  const absent = new Set<string>();
  /** The top-level layer (or page, or root-level record) each layer is in; null when it's gone. */
  const tops = new Map<string, string | null>();
  const isPage = (id: string) => doc.get(id)?.type === "page";
  const topOf = (id: string): string | null => {
    const path: string[] = [];
    let at = id;
    let top: string | null = null;
    for (;;) {
      const known = tops.get(at);
      if (known !== undefined) {
        top = known;
        break;
      }
      path.push(at);
      const node = doc.get(at);
      if (!node) break;
      if (node.parent === ROOT_ID || isPage(node.parent)) {
        top = at;
        break;
      }
      at = node.parent;
    }
    for (const step of path) tops.set(step, top);
    return top;
  };
  for (const id of reads.ids) {
    if (id === ROOT_ID || made.has(id)) continue;
    const top = topOf(id);
    if (top === null) absent.add(id);
    // A layer the run made is in the scope through the operation that made it.
    else if (!made.has(top)) units.add(top);
    if (units.size + absent.size > AGENT_SCOPE_CAP) return null;
  }
  for (const id of reads.lists) if (id === ROOT_ID || isPage(id)) lists.add(id);
  if (units.size + lists.size + absent.size > AGENT_SCOPE_CAP) return null;
  return { units: [...units], lists: [...lists], absent: [...absent] };
}
