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
  /** `off` stops the Worker from fetching Google Fonts (see api/fonts.ts). */
  readonly GOOGLE_FONTS?: string;
  /** Sign in with GitHub: an OAuth app's client id and secret (docs/self-hosting.md). */
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  /** Sign in with Google: an OAuth client's id and secret (docs/self-hosting.md). */
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
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
