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
}

export type Role = "owner" | "editor" | "viewer";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface AppContext {
  Bindings: Env;
  Variables: { user: User | null; sessionId: string | null };
}
