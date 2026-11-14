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

/** One key combination, as the editor's actions describe it (apps/web/src/editor/actions.ts). */
const Shortcut = z.object({
  key: z.string().min(1).max(24),
  mod: z.boolean().optional(),
  shift: z.boolean().optional(),
  alt: z.boolean().optional(),
});

/** Shortcuts changed from the defaults: action id → shortcut, or null to have none. */
export const Shortcuts = z
  .record(z.string().regex(/^[a-zA-Z][\w.:-]{0,63}$/, "Not an action."), Shortcut.nullable())
  .refine((m) => Object.keys(m).length <= 400, "Too many shortcuts.");
export type Shortcuts = z.infer<typeof Shortcuts>;

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

  .get("/shortcuts", async (c) => {
    const user = requireUser(c);
    const row = await c.env.DB.prepare("SELECT shortcuts FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ shortcuts: string }>();
    // What's stored was checked on the way in; anything unreadable counts as no changes.
    const parsed = Shortcuts.safeParse(JSON.parse(row?.shortcuts ?? "{}"));
    return c.json({ shortcuts: parsed.success ? parsed.data : {} });
  })

  .put("/shortcuts", async (c) => {
    const user = requireUser(c);
    const { shortcuts } = await readBody(c, z.object({ shortcuts: Shortcuts }));
    await c.env.DB.prepare("UPDATE users SET shortcuts = ? WHERE id = ?")
      .bind(JSON.stringify(shortcuts), user.id)
      .run();
    return c.json({ shortcuts });
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
