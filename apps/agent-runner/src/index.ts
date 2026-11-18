/**
 * The agent runner's Worker (decision 0033): the `AgentRunner` Durable
 * Object, one per file (`idFromName(fileId)`), which runs agent tools with
 * the headless editor, HarfBuzz and resvg, in isolates of this script's own.
 * When a call runs out of memory, this isolate is reset and the main
 * Worker's call fails; the file's room, in the main Worker's script, never
 * notices (step 0, `0033-agent-runner-step0.md`).
 *
 * Only the main Worker calls it, through its AGENT_RUNNER binding
 * (`script_name`), with a new stub for every call. It has no route.
 *
 * Its own SQLite keeps what must outlive a reset: the strikes against calls
 * that ran it out of memory (`strikes.ts`), so such a call can't loop. Only
 * the main Worker sees that error, so it records the strike (`strike`); a
 * runner that restarts never guesses at why it did.
 */
import { DurableObject } from "cloudflare:workers";
import {
  AGENT_RUN_LIMIT_MS,
  AGENT_RUNNER_ACCEPTS,
  type AgentCommittedNote,
  type AgentHeld,
  type AgentRunAnswer,
  type AgentRunRequest,
  type AgentStrike,
  RUNNER_CUT_OFF,
  TOOK_TOO_LONG,
} from "@drawpane/worker/src/agent/runner-api";
import type { Env } from "./env";
import { type Hook, Hooks } from "./hooks";
import { FileRunner } from "./runner";
import { fingerprint, STRIKES_KEPT_MS, type Strike, strikeRefusal } from "./strikes";

export class AgentRunner extends DurableObject<Env> {
  #runner: FileRunner | null = null;
  /** Calls one at a time, in the order made. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #hooks: Hooks;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#hooks = new Hooks(ctx, env.AGENT_RUNNER_TEST_HOOKS === "on");
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS strikes (fingerprint TEXT NOT NULL, at INTEGER NOT NULL)",
      );
      // A runner from before kept the call under way here, to guess at strikes: no longer.
      sql.exec("DROP TABLE IF EXISTS inflight");
      this.#hooks.create();
      sql.exec("DELETE FROM strikes WHERE at < ?", Date.now() - STRIKES_KEPT_MS);
    });
  }

  /** The file's runner. A runner is named for its file, so it only ever sees one. */
  #for(fileId: string): FileRunner {
    this.#runner ??= new FileRunner(this.env, fileId, {
      midRun: () => this.#hooks.midRun(),
    });
    return this.#runner;
  }

  async held(fileId: string): Promise<AgentHeld> {
    return this.#for(fileId).held(fileId);
  }

  run(request: AgentRunRequest): Promise<AgentRunAnswer> {
    const next = this.#queue.then(() => this.#guarded(request));
    this.#queue = next.catch(() => {});
    return next;
  }

  /**
   * Runs a call unless its strikes refuse it, for no longer than its limit
   * (AGENT_RUN_LIMIT_MS), timed from when it starts here, not from when it
   * was asked: calls on a file wait their turn, and the wait isn't theirs.
   * Past the limit it answers `late`, lets go of the file's runner so the
   * next call starts afresh, and the main Worker resets this runner to cut
   * the run off.
   */
  async #guarded(request: AgentRunRequest): Promise<AgentRunAnswer> {
    const now = Date.now();
    const print = await fingerprint(request.tool, request.input);
    const strikes: Strike[] = this.ctx.storage.sql
      .exec<{ fingerprint: string; at: number }>(
        "SELECT fingerprint, at FROM strikes WHERE at >= ?",
        now - STRIKES_KEPT_MS,
      )
      .toArray();
    const refusal = strikeRefusal(strikes, print, now);
    if (refusal) {
      if (request.source.kind === "snapshot") await request.source.body?.cancel().catch(() => {});
      return { ok: false, message: refusal };
    }
    const runner = this.#for(request.fileId);
    const answer = await withinLimit(
      runner.run(request),
      this.#hooks.runLimitMs() ?? AGENT_RUN_LIMIT_MS,
    );
    if (answer !== "late") return answer;
    // Still running: nothing it holds can be trusted, and the next call mustn't wait behind it.
    if (this.#runner === runner) this.#runner = null;
    runner.forget();
    return { ok: false, message: TOOK_TOO_LONG, late: true };
  }

  async committed(note: AgentCommittedNote): Promise<void> {
    await this.#hooks.inCommitted();
    await this.#runner?.committed(note);
  }

  async drop(fileId: string): Promise<void> {
    await this.#runner?.drop(fileId);
  }

  /**
   * A strike against a call that ran this runner out of memory, as the main
   * Worker saw it fail, at the time it failed. One older than the strikes
   * kept is a leftover and counts for nothing.
   */
  async strike(note: AgentStrike): Promise<void> {
    if (!AGENT_RUNNER_ACCEPTS.includes(note.v)) return;
    const now = Date.now();
    const at = Math.min(note.at, now);
    if (!Number.isFinite(at) || at < now - STRIKES_KEPT_MS) return;
    console.warn(`agent runner: ${note.tool} ran out of memory, a strike against it`);
    this.ctx.storage.sql.exec(
      "INSERT INTO strikes (fingerprint, at) VALUES (?, ?)",
      await fingerprint(note.tool, note.input),
      at,
    );
  }

  /**
   * Resets this runner, cutting off a run still going past its limit (the
   * main Worker heard `late`). Calls waiting behind it fail with
   * RUNNER_CUT_OFF, which the main Worker runs again. Not a strike: only
   * running out of memory is.
   */
  async reset(): Promise<void> {
    this.ctx.abort(RUNNER_CUT_OFF);
  }

  /** Arms a chaos hook (`hooks.ts`), when the tests turned them on. */
  async arm(hook: Hook, times = 1, ms = 0): Promise<void> {
    this.#hooks.arm(hook, times, ms);
  }

  /** What tests check: the revision held, cold builds and strikes. */
  async stats(): Promise<{ revn: number | null; builds: number; strikes: number }> {
    const held = this.#runner ? await this.#runner.held("") : null;
    const strikes = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM strikes")
      .one().n;
    return {
      revn: held?.revn ?? null,
      builds: this.#runner?.builds ?? 0,
      strikes,
    };
  }
}

/** The run's answer, or "late" when it hasn't come within `ms`. */
async function withinLimit<T>(run: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
    // A run that answers after the limit, or fails then, is nobody's answer.
    run.catch(() => {});
  }
}

/** Nothing answers here: the runner is reached only through the main Worker's binding. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
