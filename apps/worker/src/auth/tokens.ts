/**
 * Personal access tokens (docs/decisions/0011-mcp-server.md): created and
 * revoked from the account page, and accepted as `Authorization: Bearer` by
 * the MCP endpoint only. Only a token's SHA-256 is stored; the token itself
 * is shown once, when it's made. A token reads, or reads and writes
 * (decision 0021): only a write token can start an agent session.
 */
import { newId } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { readBody } from "../api/access";
import type { AppContext, Env, User } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, notFound } from "../lib/http";
import { requireUser } from "./session";

/** Every token starts so: easy to spot in a config file, and for secret scanners. */
export const TOKEN_PREFIX = "dp_pat_";
/** At most this many tokens per person. */
const MAX_TOKENS = 50;
const DAY = 86_400_000;
/** Last use is recorded at most this often per token. */
const LAST_USED_GRANULARITY = 60_000;

/** What a token may do: `read` files, or also `write` to them through agent sessions. */
export type TokenScope = "read" | "write";

export interface ApiToken {
  readonly id: string;
  readonly name: string;
  /** The start of the token, to recognise it by. */
  readonly prefix: string;
  readonly scope: TokenScope;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scope: TokenScope;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

const toToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scope: row.scope,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
});

const COLUMNS = "id, name, prefix, scope, created_at, last_used_at, expires_at";

export const tokens = new Hono<AppContext>()
  /** Your tokens, newest first. */
  .get("/", async (c) => {
    const user = requireUser(c);
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLUMNS} FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(user.id)
      .all<TokenRow>();
    return c.json({ tokens: results.map(toToken) });
  })

  /** Makes a token. The answer is the only time the token itself is shown. */
  .post("/", async (c) => {
    const user = requireUser(c);
    const body = await readBody(
      c,
      z.object({
        name: z.string().trim().min(1, "Name the token: what will use it?").max(80),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
        scope: z.enum(["read", "write"]).default("read"),
      }),
    );
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_TOKENS)
      throw badRequest(`You have ${MAX_TOKENS} tokens. Revoke one you no longer use first.`);
    const token = `${TOKEN_PREFIX}${randomToken()}`;
    const now = Date.now();
    const row: TokenRow = {
      id: newId(),
      name: body.name,
      prefix: token.slice(0, TOKEN_PREFIX.length + 4),
      scope: body.scope,
      created_at: now,
      last_used_at: null,
      expires_at: body.expiresInDays === null ? null : now + body.expiresInDays * DAY,
    };
    await c.env.DB.prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        user.id,
        row.name,
        await sha256Hex(token),
        row.prefix,
        row.scope,
        row.created_at,
        row.expires_at,
      )
      .run();
    return c.json({ token, info: toToken(row) }, 201);
  })

  /** Revokes a token: whatever uses it stops working at once. */
  .delete("/:tokenId", async (c) => {
    const user = requireUser(c);
    const { meta } = await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
      .bind(c.req.param("tokenId"), user.id)
      .run();
    if (!meta.changes) throw notFound("That token doesn't exist.");
    return c.json({ ok: true });
  });

/**
 * The person a bearer token acts as, with the token and its scope, or null
 * for a missing, malformed, unknown, revoked or expired token. Notes when it
 * was last used.
 */
export async function userForBearer(env: Env, authorization: string | undefined) {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const token = match?.[1];
  if (!token?.startsWith(TOKEN_PREFIX) || token.length > 128) return null;
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.scope, t.last_used_at, t.expires_at, u.id, u.email, u.name, u.is_admin
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<{
      token_id: string;
      scope: TokenScope;
      last_used_at: number | null;
      expires_at: number | null;
      id: string;
      email: string;
      name: string;
      is_admin: number;
    }>();
  const now = Date.now();
  if (!row || (row.expires_at !== null && row.expires_at <= now)) return null;
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_GRANULARITY)
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .bind(now, row.token_id)
      .run();
  const user: User = { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin === 1 };
  return { user, tokenId: row.token_id, scope: row.scope };
}
