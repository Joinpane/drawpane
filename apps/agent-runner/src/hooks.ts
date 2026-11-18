/**
 * Chaos hooks for the tests (decision 0033, migration step 4): ways to
 * make the runner fail as Cloudflare would make it fail, at chosen points
 * of a call. Only when `AGENT_RUNNER_TEST_HOOKS=on`, which the main
 * Worker's vitest config sets and nothing deployed does; otherwise `arm`
 * refuses and the points do nothing.
 *
 * - `abort-mid-run`: after the tool ran, before the run answers, the
 *   runner resets itself (`ctx.abort()`) with the error Cloudflare gives
 *   when it runs out of memory (step 0).
 * - `restart-mid-run`: the same point, reset with the error a deploy gives
 *   (step 0): a routine restart, not a crash.
 * - `abort-in-committed`: the runner resets as it hears how the commit
 *   went, after the room committed.
 * - `hang`: the run never answers.
 * - `slow`: the run takes `ms` longer.
 * - `run-limit`: the runner's limit on a run is `ms` (AGENT_RUN_LIMIT_MS
 *   otherwise), for as many calls as armed.
 *
 * Armed hooks are kept in the runner's SQLite, so a hook armed for several
 * calls outlives the resets it causes.
 */
export type Hook =
  | "abort-mid-run"
  | "restart-mid-run"
  | "abort-in-committed"
  | "hang"
  | "slow"
  | "run-limit";

/** What step 0 saw Cloudflare say when a runner Durable Object ran out of memory. */
export const OUT_OF_MEMORY_RESET =
  "Durable Object's isolate exceeded its memory limit and was reset.";
/** What step 0 saw Cloudflare say when one was reset for a deploy. */
export const CODE_UPDATED_RESET = "Durable Object reset because its code was updated.";

export class Hooks {
  readonly #ctx: DurableObjectState;
  readonly #on: boolean;

  constructor(ctx: DurableObjectState, on: boolean) {
    this.#ctx = ctx;
    this.#on = on;
  }

  create(): void {
    if (!this.#on) return;
    const sql = this.#ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS hooks (hook TEXT PRIMARY KEY, times INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0)",
    );
  }

  arm(hook: Hook, times: number, ms = 0): void {
    if (!this.#on) throw new Error("The agent runner's test hooks are off.");
    this.#ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO hooks (hook, times, ms) VALUES (?, ?, ?)",
      hook,
      times,
      ms,
    );
  }

  async midRun(): Promise<void> {
    const slow = await this.#take("slow");
    if (slow !== null) await new Promise((resolve) => setTimeout(resolve, slow));
    if ((await this.#take("hang")) !== null) await new Promise(() => {});
    if ((await this.#take("abort-mid-run")) !== null) this.#ctx.abort(OUT_OF_MEMORY_RESET);
    if ((await this.#take("restart-mid-run")) !== null) this.#ctx.abort(CODE_UPDATED_RESET);
  }

  async inCommitted(): Promise<void> {
    if ((await this.#take("abort-in-committed")) !== null)
      this.#ctx.abort("Test hook: abort in committed.");
  }

  /** The limit on this run, when the tests set one. */
  runLimitMs(): number | null {
    if (!this.#on) return null;
    const row = this.#ctx.storage.sql
      .exec<{ times: number; ms: number }>("SELECT times, ms FROM hooks WHERE hook = 'run-limit'")
      .toArray()[0];
    return row && row.times > 0 ? row.ms : null;
  }

  /** Uses one of a hook's armed times, on disk before the reset it may cause: its `ms`, or null. */
  async #take(hook: Hook): Promise<number | null> {
    if (!this.#on) return null;
    const sql = this.#ctx.storage.sql;
    const row = sql
      .exec<{ times: number; ms: number }>("SELECT times, ms FROM hooks WHERE hook = ?", hook)
      .toArray()[0];
    if (!row || row.times <= 0) return null;
    sql.exec("UPDATE hooks SET times = times - 1 WHERE hook = ?", hook);
    await this.#ctx.storage.sync();
    return row.ms;
  }
}
