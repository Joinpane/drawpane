/**
 * Unsubscribing from Drawpane's emails, with the signed link every email
 * carries (email/notify.ts). It needs no sign-in: the link is the proof.
 *
 * - POST, as mail apps do for one-click unsubscribe (RFC 8058): turns
 *   email off for that person.
 * - GET, as a click in the email does: shows a page that asks first, so a
 *   link scanner fetching it can't unsubscribe anyone.
 */
import { Hono } from "hono";
import { unsubscribeUser } from "../email/notify";
import type { AppContext } from "../env";
import { notFound } from "../lib/http";

export const email = new Hono<AppContext>()
  .get("/unsubscribe", (c) => {
    const token = c.req.query("token") ?? "";
    return c.redirect(`/unsubscribe?token=${encodeURIComponent(token)}`, 302);
  })

  .post("/unsubscribe", async (c) => {
    const userId = await unsubscribeUser(c.env.SESSION_SECRET, c.req.query("token") ?? "");
    if (!userId)
      throw notFound(
        "That unsubscribe link isn't valid. Change email settings in your account instead.",
      );
    const user = await c.env.DB.prepare(
      "UPDATE users SET email_notifications = 'off' WHERE id = ? RETURNING email",
    )
      .bind(userId)
      .first<{ email: string }>();
    if (!user) throw notFound("That account no longer exists.");
    return c.json({ ok: true, email: user.email });
  });
