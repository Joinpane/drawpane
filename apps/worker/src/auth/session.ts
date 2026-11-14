import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext, Env, User } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { unauthorized } from "../lib/http";

/** `__Host-` pins the cookie to this exact origin: Secure, Path=/, no Domain. */
export const SESSION_COOKIE = "__Host-dp_session";
const SESSION_DAYS = 30;
const DAY = 86_400_000;

export async function createSession(c: Context<AppContext>, userId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256Hex(token),
      userId,
      now,
      now + SESSION_DAYS * DAY,
      c.req.header("user-agent")?.slice(0, 256) ?? null,
    )
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession(c: Context<AppContext>): Promise<void> {
  const sessionId = c.get("sessionId");
  if (sessionId) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

interface SessionRow {
  session_id: string;
  expires_at: number;
  id: string;
  email: string;
  name: string;
  is_admin: number;
}

/** Resolves the session cookie to a user. Extends sessions that are past half their life. */
export async function readSession(
  env: Env,
  token: string | undefined,
): Promise<{ user: User; sessionId: string } | null> {
  if (!token || token.length > 128) return null;
  const sessionId = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(sessionId, Date.now())
    .first<SessionRow>();
  if (!row) return null;
  if (row.expires_at - Date.now() < (SESSION_DAYS / 2) * DAY) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(Date.now() + SESSION_DAYS * DAY, sessionId)
      .run();
  }
  return {
    user: { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin === 1 },
    sessionId,
  };
}

/** Attaches the signed-in user (or null) to the request. */
export const session = createMiddleware<AppContext>(async (c, next) => {
  const result = await readSession(c.env, getCookie(c, SESSION_COOKIE));
  c.set("user", result?.user ?? null);
  c.set("sessionId", result?.sessionId ?? null);
  await next();
});

export function requireUser(c: Context<AppContext>): User {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}
