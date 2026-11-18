/**
 * Chaos hooks for the tests (decision 0033, migration step 4): ways to
 * make the runner fail as Cloudflare would make it fail, at chosen points
 * of a call. Only when `AGENT_RUNNER_TEST_HOOKS=on`, which the main
 * Worker's vitest config sets and nothing deployed does; otherwise `arm`
 * refuses and the points do nothing.
 *
 * - `abort-mid-run`: after the tool ran, before the run answers, the
 *   runner resets itself (`ctx.abort()`), as when it runs out of memory.
 * - `abort-in-committed`: the runner resets as it hears how the commit
 *   went, after the room committed.
 * - `hang`: the run never answers.
 *
 * Armed hooks are kept in the runner's SQLite, so a hook armed for several
 * calls outlives the resets it causes.
 */
export type Hook = "abort-mid-run" | "abort-in-committed" | "hang";

export class Hooks {
  readonly #ctx: DurableObjectState;
  readonly #on: boolean;

  constructor(ctx: DurableObjectState, on: boolean) {
    this.#ctx = ctx;
    this.#on = on;
  }

  create(): void {
    if (!this.#on) return;
    this.#ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hooks (hook TEXT PRIMARY KEY, times INTEGER NOT NULL)",
    );
  }

  arm(hook: Hook, times: number): void {
    if (!this.#on) throw new Error("The agent runner's test hooks are off.");
    this.#ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO hooks (hook, times) VALUES (?, ?)",
      hook,
      times,
    );
  }

  async midRun(): Promise<void> {
    if (await this.#take("hang")) await new Promise(() => {});
    if (await this.#take("abort-mid-run")) this.#ctx.abort("Test hook: abort mid-run.");
  }

  async inCommitted(): Promise<void> {
    if (await this.#take("abort-in-committed")) this.#ctx.abort("Test hook: abort in committed.");
  }

  /** Uses one of a hook's armed times, on disk before the reset it may cause. */
  async #take(hook: Hook): Promise<boolean> {
    if (!this.#on) return false;
    const sql = this.#ctx.storage.sql;
    const row = sql
      .exec<{ times: number }>("SELECT times FROM hooks WHERE hook = ?", hook)
      .toArray();
    const times = row[0]?.times ?? 0;
    if (times <= 0) return false;
    sql.exec("UPDATE hooks SET times = times - 1 WHERE hook = ?", hook);
    await this.#ctx.storage.sync();
    return true;
  }
}
