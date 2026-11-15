import type { FileRoom } from "./rooms/file-room";

/** Bindings and secrets, as configured in wrangler.jsonc and `wrangler secret put`. */
export interface Env {
  readonly DB: D1Database;
  /** Snapshots, media and fonts. */
  readonly FILES: R2Bucket;
  readonly FILE_ROOM: DurableObjectNamespace<FileRoom>;
  readonly ASSETS: Fetcher;
  /** Signs WebAuthn challenges and FileRoom claims. At least 32 random bytes. */
  readonly SESSION_SECRET: string;
  /** Required to create the first account on a fresh install. */
  readonly SETUP_TOKEN?: string;
  /** Shown by the browser's passkey prompt. */
  readonly RP_NAME?: string;
  /**
   * The origin(s) people open, comma-separated, e.g. `http://localhost:5173`.
   * Only needed in local development, where `wrangler dev` rewrites the
   * request host to the production route. Unset in production.
   */
  readonly PUBLIC_ORIGIN?: string;
  /** The Drawpane release this Worker is, set by the installer (unset when installed by hand). */
  readonly DRAWPANE_VERSION?: string;
  /** `off` stops the health page from asking npm whether a newer release is out (api/updates.ts). */
  readonly UPDATE_CHECK?: string;
  /** `off` stops the Worker from fetching Google Fonts (see api/fonts.ts). */
  readonly GOOGLE_FONTS?: string;
  /**
   * `standin` turns on the agent tools with a stand-in text measurer, for
   * tests and local development (see agent/measurer.ts). Unset in production.
   */
  readonly AGENT_MEASURER?: string;
  /** Sign in with GitHub: an OAuth app's client id and secret (docs/self-hosting.md). */
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  /** Sign in with Google: an OAuth client's id and secret (docs/self-hosting.md). */
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  /**
   * Email (email/setup.ts, docs/decisions/0006-email.md): which way to send
   * (`off` by default), who it's from, and that provider's credentials.
   */
  readonly EMAIL_PROVIDER?: string;
  readonly EMAIL_FROM?: string;
  readonly EMAIL_API_KEY?: string;
  readonly MAILGUN_DOMAIN?: string;
  readonly MAILGUN_REGION?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly AWS_REGION?: string;
  readonly SMTP_URL?: string;
  /** Cloudflare Email Service: a send_email binding. */
  readonly EMAIL?: { send(message: unknown): Promise<void> };
}

export type Role = "owner" | "editor" | "viewer";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** Runs the instance: sees its health, cost and settings. */
  readonly isAdmin: boolean;
}

export interface AppContext {
  Bindings: Env;
  Variables: { user: User | null; sessionId: string | null };
}
