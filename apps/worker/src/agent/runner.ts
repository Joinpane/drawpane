/**
 * The agent runner, in-process (decision 0033, migration step 1): the
 * headless engine (`AgentEngine`), its text measurer and the renderer
 * behind `AgentRunnerApi`. For now the file's room hosts it and hands it
 * the file (`AgentSource`); migration step 3 moves it into a script of its
 * own, where the file arrives as a snapshot stream or log pages instead.
 *
 * It never commits. A write tool's run answers with the operations it made
 * and the revision it ran on; the main Worker hands those to the room and
 * tells the runner how the commit went (`committed`). Until then the
 * editor holds changes the file doesn't have yet, so anything else that
 * reaches it first (a person's transaction, another run) lets it go.
 */
import {
  type DocReads,
  findTool,
  type HeadlessRenderer,
  ToolFailure,
  type ToolServices,
} from "@drawpane/editor";
import type { CopiesFormat, NodeRecord, Op } from "@drawpane/model";
import type { Env } from "../env";
import { AgentTooLarge } from "../rooms/agent-admission";
import { AgentEngine, type EngineRun } from "../rooms/agent-engine";
import { fileFontLoader } from "./harfbuzz";
import { agentMeasurer } from "./measurer";
import { headlessRenderer } from "./render";
import {
  AGENT_READ_CAP,
  AGENT_RUNNER_V,
  type AgentCommittedNote,
  type AgentReadSet,
  type AgentRunAnswer,
  type AgentRunnerApi,
  type AgentRunRequest,
} from "./runner-api";

/** How often a write runs again to measure text in a font it didn't have loaded. */
const FONT_ATTEMPTS = 3;

export const NO_ENGINE =
  "Agents can't design on this instance yet: it has no text measurer configured. Reading still works.";
const OUT_OF_STEP =
  "The agent runner was updated during that call, and changed nothing. Try again.";

/** The file as the in-process runner reads it: the hosting room's rows at its revision now. */
export interface AgentSource {
  revn(): number;
  copies(): CopiesFormat;
  count(): number;
  records(): Iterable<NodeRecord>;
}

export class InProcessAgentRunner implements AgentRunnerApi {
  readonly #env: Env;
  readonly #fileId: string;
  readonly #source: AgentSource;
  #engine: AgentEngine | null = null;
  #rendering: Promise<HeadlessRenderer> | null = null;
  /** Calls one at a time, in the order made. */
  #queue: Promise<unknown> = Promise.resolve();
  /** A run is under way: its editor is changing. */
  #running = false;
  /** The run whose changes the editor holds, uncommitted, and the revision it ran on. */
  #pending: { runId: string; baseRevn: number } | null = null;
  /** The revision the editor's meter refused the file at, and why: asked again, refused at once. */
  #refusal: { revn: number; message: string } | null = null;

  constructor(env: Env, fileId: string, source: AgentSource) {
    this.#env = env;
    this.#fileId = fileId;
    this.#source = source;
  }

  run(request: AgentRunRequest): Promise<AgentRunAnswer> {
    const next = this.#queue.then(() => this.#run(request));
    this.#queue = next.catch(() => {});
    return next;
  }

  async committed(note: AgentCommittedNote): Promise<void> {
    if (note.v !== AGENT_RUNNER_V || this.#pending?.runId !== note.runId) return;
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

  // -- The host's side (in-process only) -------------------------------------

  /** The room committed a transaction: the warm editor follows it, or is let go. */
  follow(ops: readonly Op[], revn: number): void {
    if (!this.#engine) return;
    // Mid-run, or holding a run's changes: it isn't the file the room committed on top of.
    if (this.#running || this.#pending) this.forget();
    else this.#engine.follow(ops, revn);
  }

  /** The room's file changed in a way the editor can't follow (an import, a restore). */
  forget(): void {
    this.#engine?.drop();
    this.#pending = null;
  }

  // ---------------------------------------------------------------------------

  async #run(request: AgentRunRequest): Promise<AgentRunAnswer> {
    if (request.v !== AGENT_RUNNER_V) return { ok: false, message: OUT_OF_STEP };
    const tool = findTool(request.tool);
    if (!tool) return { ok: false, message: `There's no tool ${request.tool}.` };
    const engine = this.#engineFor();
    if (!engine) return { ok: false, message: NO_ENGINE };
    // A run before this one whose commit it never heard about: the editor isn't the file.
    if (this.#pending) this.forget();
    const write = tool.level === "write";
    try {
      // The fonts the file is set in, loaded before anything is measured (or drawn).
      if (write || request.tool === "export_image") {
        const missing = engine.missingFaces(this.#editor(engine));
        if (missing.length > 0) await engine.load(missing);
      }
      for (let attempt = 0; ; attempt++) {
        const baseRevn = this.#source.revn();
        const editor = this.#editor(engine);
        const services: ToolServices = write
          ? {}
          : {
              renderPng: async (id, options) =>
                (await this.#renderer(engine)).renderPng(editor.doc, id, options),
            };
        let run: EngineRun;
        this.#running = true;
        // What the tool and the layout it sets off read: the commit depends on it.
        const reads = write ? editor.doc.trackReads() : null;
        try {
          run = await engine.run(editor, request.tool, request.input, services);
        } finally {
          if (write) editor.doc.untrackReads();
          this.#running = false;
        }
        // Text in a font not loaded yet: load it, and run again so it's measured right.
        if (write && attempt < FONT_ATTEMPTS - 1) {
          const fonts = engine.facesMissingFrom(editor, run.ops);
          if (fonts.length > 0) {
            engine.drop();
            await engine.load(fonts);
            continue;
          }
        }
        const runId = crypto.randomUUID();
        if (run.ops.length > 0) this.#pending = { runId, baseRevn };
        const { data, image } = run.result;
        return {
          ok: true,
          runId,
          baseRevn,
          ops: run.ops,
          reads: reads ? readSet(reads, run.ops) : { ids: [], lists: [], instances: [] },
          result: data ?? null,
          ...(image ? { image } : {}),
        };
      }
    } catch (error) {
      if (error instanceof ToolFailure) return { ok: false, message: error.message };
      // Anything else is a bug: logged, and everything let go in case it was left half-done.
      console.error(`agent tool ${request.tool} failed`, error);
      this.forget();
      return {
        ok: false,
        message: `${request.tool} failed unexpectedly, and changed nothing. Try it another way, or in smaller steps.`,
      };
    }
  }

  /** The engine, made with the file's measurer; null when none is configured. */
  #engineFor(): AgentEngine | null {
    if (this.#engine) return this.#engine;
    const measurer = agentMeasurer(this.#env, this.#fileId);
    if (!measurer) return null;
    this.#engine = new AgentEngine(measurer);
    return this.#engine;
  }

  /**
   * The editor at the room's revision, kept warm or built from its rows,
   * metered as it's built. A file the meter stops partway is refused
   * (`AgentTooLarge`), and the refusal is kept for that revision, so asking
   * again doesn't build it again.
   */
  #editor(engine: AgentEngine) {
    const source = this.#source;
    const revn = source.revn();
    if (this.#refusal?.revn === revn) throw new AgentTooLarge(this.#refusal.message);
    try {
      return engine.editorAt(revn, source.count(), () => source.records(), source.copies());
    } catch (error) {
      if (error instanceof AgentTooLarge) this.#refusal = { revn, message: error.message };
      throw error;
    }
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

/**
 * What a run read, less the layers it made (nobody else can have changed
 * those): null when it read everything or more than AGENT_READ_CAP ids.
 */
export function readSet(reads: DocReads, ops: readonly Op[]): AgentReadSet {
  if (reads.all) return null;
  const made = new Set<string>();
  for (const op of ops) if (op.op === "create") made.add(op.id);
  const keep = (ids: Set<string>) => [...ids].filter((id) => !made.has(id));
  const ids = keep(reads.ids);
  const lists = keep(reads.lists);
  const instances = keep(reads.instances);
  if (ids.length + lists.length + instances.length > AGENT_READ_CAP) return null;
  return { ids, lists, instances };
}
