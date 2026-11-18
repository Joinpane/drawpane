import type { AgentRunner } from "./index";

/** The agent runner's bindings (wrangler.jsonc): the main Worker's database and bucket, read only. */
export interface Env {
  readonly DB: D1Database;
  /** Fonts, images and saved versions (snapshots). */
  readonly FILES: R2Bucket;
  /** Its own class, bound so `wrangler dev` runs it beside the main Worker; never called here. */
  readonly AGENT_RUNNER?: DurableObjectNamespace<AgentRunner>;
  /** `off` stops fetching Google Fonts, as in the main Worker (its api/fonts.ts). */
  readonly GOOGLE_FONTS?: string;
  /**
   * `standin` measures text with the deterministic stand-in instead of
   * HarfBuzz, for tests and local development (measurer.ts). Unset in
   * production.
   */
  readonly AGENT_MEASURER?: string;
  /** `on` lets tests arm the chaos hooks (hooks.ts). Never set in production. */
  readonly AGENT_RUNNER_TEST_HOOKS?: string;
}
