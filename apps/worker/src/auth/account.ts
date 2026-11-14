/**
 * Your account: name, and the ways you sign in (passkeys, GitHub, Google).
 * Removing one is fine while another remains; the last one stays, so nobody
 * locks themselves out.
 */
import { Hono } from "hono";
import { z } from "zod";
import { readBody } from "../api/access";
import type { AppContext, User } from "../env";
import { conflict, notFound } from "../lib/http";
import { signInMethods } from "./oauth";
import { requireUser } from "./session";

async function methodCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM passkeys WHERE user_id = ?1)
            + (SELECT COUNT(*) FROM oauth_identities WHERE user_id = ?1) AS n`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const LAST_ONE =
  "That's your only way to sign in. Add another first, so you can still get back in.";

export const account = new Hono<AppContext>()
  .get("/", async (c) => {
    const user = requireUser(c);
    return c.json({ user, ...(await signInMethods(c, user)) });
  })

  .patch("/", async (c) => {
    const user = requireUser(c);
    const { name } = await readBody(
      c,
      z.object({ name: z.string().trim().min(1, "Enter your name.").max(80) }),
    );
    await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
    const updated: User = { ...user, name };
    return c.json({ user: updated });
  })

  .delete("/identities/:provider", async (c) => {
    const user = requireUser(c);
    const provider = c.req.param("provider");
    const row = await c.env.DB.prepare(
      "SELECT 1 FROM oauth_identities WHERE user_id = ? AND provider = ?",
    )
      .bind(user.id, provider)
      .first();
    if (!row) throw notFound("That account isn't connected.");
    if ((await methodCount(c.env.DB, user.id)) <= 1) throw conflict(LAST_ONE);
    await c.env.DB.prepare("DELETE FROM oauth_identities WHERE user_id = ? AND provider = ?")
      .bind(user.id, provider)
      .run();
    return c.json({ ok: true });
  })

  .delete("/passkeys/:id", async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    const row = await c.env.DB.prepare("SELECT 1 FROM passkeys WHERE user_id = ? AND id = ?")
      .bind(user.id, id)
      .first();
    if (!row) throw notFound("That passkey isn't yours, or it was already removed.");
    if ((await methodCount(c.env.DB, user.id)) <= 1) throw conflict(LAST_ONE);
    await c.env.DB.prepare("DELETE FROM passkeys WHERE user_id = ? AND id = ?")
      .bind(user.id, id)
      .run();
    return c.json({ ok: true });
  });
