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
 * Its own SQLite keeps what must outlive a reset: the call under way
 * (`inflight`) and the strikes against calls that never returned
 * (`strikes.ts`), so a call that kills the runner can't loop.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  AgentCommittedNote,
  AgentHeld,
  AgentRunAnswer,
  AgentRunRequest,
} from "@drawpane/worker/src/agent/runner-api";
import type { Env } from "./env";
import { type Hook, Hooks } from "./hooks";
import { FileRunner } from "./runner";
import { fingerprint, STRIKES_KEPT_MS, type Strike, strikeRefusal } from "./strikes";

export class AgentRunner extends DurableObject<Env> {
  #runner: FileRunner | null = null;
  /** Calls one at a time, in the order made: the `inflight` row holds one. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #hooks: Hooks;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#hooks = new Hooks(ctx, env.AGENT_RUNNER_TEST_HOOKS === "on");
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS inflight (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        fingerprint TEXT NOT NULL, tool TEXT NOT NULL, revn INTEGER NOT NULL, at INTEGER NOT NULL)`);
      sql.exec(
        "CREATE TABLE IF NOT EXISTS strikes (fingerprint TEXT NOT NULL, at INTEGER NOT NULL)",
      );
      this.#hooks.create();
      // A call that was under way when this runner last stopped never returned: it killed it.
      const left = sql.exec<{ fingerprint: string; tool: string }>(
        "SELECT fingerprint, tool FROM inflight",
      );
      for (const row of left) {
        console.warn(`agent runner: ${row.tool} never returned, a strike against it`);
        sql.exec(
          "INSERT INTO strikes (fingerprint, at) VALUES (?, ?)",
          row.fingerprint,
          Date.now(),
        );
      }
      sql.exec("DELETE FROM inflight");
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

  /** Runs a call unless its strikes refuse it, with its `inflight` row written first. */
  async #guarded(request: AgentRunRequest): Promise<AgentRunAnswer> {
    const sql = this.ctx.storage.sql;
    const print = await fingerprint(request.tool, request.input);
    const strikes: Strike[] = sql
      .exec<{ fingerprint: string; at: number }>("SELECT fingerprint, at FROM strikes")
      .toArray();
    const refusal = strikeRefusal(strikes, print, Date.now());
    if (refusal) {
      if (request.source.kind === "snapshot") await request.source.body?.cancel().catch(() => {});
      return { ok: false, message: refusal };
    }
    sql.exec(
      "INSERT OR REPLACE INTO inflight (id, fingerprint, tool, revn, at) VALUES (1, ?, ?, ?, ?)",
      print,
      request.tool,
      request.source.revn,
      Date.now(),
    );
    // On disk before anything heavy runs: the isolate may not get another chance.
    await this.ctx.storage.sync();
    try {
      return await this.#for(request.fileId).run(request);
    } finally {
      sql.exec("DELETE FROM inflight");
    }
  }

  async committed(note: AgentCommittedNote): Promise<void> {
    await this.#hooks.inCommitted();
    await this.#runner?.committed(note);
  }

  async drop(fileId: string): Promise<void> {
    await this.#runner?.drop(fileId);
  }

  /**
   * Resets this runner: the main Worker gave up waiting on a call (90 s).
   * A call still under way is cut off, and counts as a strike, since its
   * `inflight` row is still there when the runner starts again.
   */
  async reset(): Promise<void> {
    this.ctx.abort("The main Worker stopped waiting for a call.");
  }

  /** Arms a chaos hook (`hooks.ts`), when the tests turned them on. */
  async arm(hook: Hook, times = 1): Promise<void> {
    this.#hooks.arm(hook, times);
  }

  /** What tests check: the revision held, cold builds, strikes and the call under way. */
  async stats(): Promise<{
    revn: number | null;
    builds: number;
    strikes: number;
    inflight: number;
  }> {
    const held = this.#runner ? await this.#runner.held("") : null;
    const count = (table: string) =>
      this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return {
      revn: held?.revn ?? null,
      builds: this.#runner?.builds ?? 0,
      strikes: count("strikes"),
      inflight: count("inflight"),
    };
  }
}

/** Nothing answers here: the runner is reached only through the main Worker's binding. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
