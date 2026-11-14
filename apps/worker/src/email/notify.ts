/**
 * Emails about the inbox (docs/decisions/0006-email.md), run by a Cron
 * Trigger every few minutes:
 *
 * - A notification is emailed if it's still unread a while after it
 *   happened (seen in the app: no email), at most once, and only recent
 *   ones (turning email on doesn't send last month's).
 * - People who want them as they happen get one email per run listing
 *   what's new; those who want a daily digest get it once a day, at the
 *   hour they picked, in their time zone; those who said no get none.
 * - Rows are claimed (emailed_at) before sending, so overlapping runs
 *   don't send twice; a failure worth retrying gives them back, a few times.
 * - A run sends a bounded number of emails (each is a subrequest), and the
 *   next run carries on.
 */
import type { Env } from "../env";
import { signPayload, verifyPayload } from "../lib/crypto";
import {
  emailLink,
  emailPage,
  emailRow,
  emailText,
  escapeHtml,
  footerLink,
  oneLine,
} from "./layout";
import { EmailError, type EmailMessage } from "./message";
import { emailSetup } from "./setup";

/** Unread this long after it happened, it's worth an email. */
export const EMAIL_GRACE_MS = 10 * 60_000;
/** Older than this, it's not news: never emailed. */
const NEWS_MS = 7 * 86_400_000;
/** Tries before giving up on a notification's email. */
const MAX_ATTEMPTS = 5;
/** Emails one run sends at most (a Worker invocation's subrequests are limited). */
const EMAILS_PER_RUN = 40;
/** Items an email lists; the rest are in the inbox. */
const LISTED = 20;

export type EmailPreference = "instant" | "daily" | "off";

interface Row {
  id: string;
  user_id: string;
  kind: "mention" | "reply" | "resolved";
  created_at: number;
  thread_id: string;
  file_id: string;
  file_name: string;
  origin: string | null;
  email_attempts: number;
  actor_name: string | null;
  user_email: string;
  user_name: string;
  pref: EmailPreference;
  digest_hour: number;
  time_zone: string | null;
  last_digest_at: number | null;
  body: string | null;
}

export interface EmailRunResult {
  readonly sent: number;
  readonly failed: number;
}

/** The hour it is for someone, 0–23, in their time zone (UTC when unknown or invalid). */
export function localHour(now: number, timeZone: string | null): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? "UTC",
      hour: "numeric",
      hourCycle: "h23",
    }).format(now);
    return Number(hour) % 24;
  } catch {
    return new Date(now).getUTCHours();
  }
}

/** Whether a person's batch goes out now: as it happens, or their digest hour (once a day). */
export function due(
  person: {
    pref: EmailPreference;
    digest_hour: number;
    time_zone: string | null;
    last_digest_at: number | null;
  },
  now: number,
): boolean {
  if (person.pref === "instant") return true;
  if (person.pref !== "daily") return false;
  if (localHour(now, person.time_zone) !== person.digest_hour) return false;
  // Once a day: the hour has a dozen runs.
  return person.last_digest_at === null || now - person.last_digest_at > 20 * 3_600_000;
}

/** Sends what's due. Does nothing when email is off. */
export async function sendNotificationEmails(env: Env, now = Date.now()): Promise<EmailRunResult> {
  const { sender } = emailSetup(env);
  if (!sender) return { sent: 0, failed: 0 };
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.user_id, n.kind, n.created_at, n.thread_id, n.file_id, f.name AS file_name,
            n.email_attempts, a.name AS actor_name, u.email AS user_email, u.name AS user_name,
            u.email_notifications AS pref, u.digest_hour, u.time_zone, u.last_digest_at,
            COALESCE(n.origin, (SELECT o.origin FROM notifications o WHERE o.origin IS NOT NULL
                                 ORDER BY o.created_at DESC LIMIT 1)) AS origin,
            COALESCE(c.body, (SELECT fc.body FROM comments fc WHERE fc.thread_id = n.thread_id
                               ORDER BY fc.created_at, fc.id LIMIT 1)) AS body
       FROM notifications n
       JOIN users u ON u.id = n.user_id AND u.email_notifications <> 'off'
       JOIN files f ON f.id = n.file_id AND f.deleted_at IS NULL
       JOIN team_members tm ON tm.team_id = f.team_id AND tm.user_id = n.user_id
       LEFT JOIN comments c ON c.id = n.comment_id
       LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.emailed_at IS NULL AND n.read_at IS NULL
        AND n.created_at <= ?1 AND n.created_at >= ?2 AND n.email_attempts < ?3
      ORDER BY n.user_id, n.created_at DESC
      LIMIT 1000`,
  )
    .bind(now - EMAIL_GRACE_MS, now - NEWS_MS, MAX_ATTEMPTS)
    .all<Row>();

  const byPerson = new Map<string, Row[]>();
  for (const row of results) {
    const rows = byPerson.get(row.user_id) ?? [];
    rows.push(row);
    byPerson.set(row.user_id, rows);
  }

  let sent = 0;
  let failed = 0;
  for (const rows of byPerson.values()) {
    if (sent + failed >= EMAILS_PER_RUN) break;
    const person = rows[0] as Row;
    if (!due(person, now)) continue;
    const ids = rows.map((r) => r.id);
    // Claimed first: a run that overlaps this one finds them taken.
    const claim = await env.DB.prepare(
      `UPDATE notifications SET emailed_at = ? WHERE emailed_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(now, ...ids)
      .run();
    if (claim.meta.changes === 0) continue;
    try {
      await sender.send(await notificationEmail(env, person, rows));
      sent++;
      if (person.pref === "daily")
        await env.DB.prepare("UPDATE users SET last_digest_at = ? WHERE id = ?")
          .bind(now, person.user_id)
          .run();
    } catch (error) {
      failed++;
      const retry = !(error instanceof EmailError) || error.retryable;
      console.error(`couldn't email ${person.user_id}`, error);
      await env.DB.prepare(
        `UPDATE notifications SET email_attempts = email_attempts + 1${retry ? ", emailed_at = NULL" : ""}
          WHERE id IN (${ids.map(() => "?").join(", ")})`,
      )
        .bind(...ids)
        .run();
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Unsubscribing: a signed link per person, good until they change their mind.

interface UnsubscribeClaim {
  readonly uid: string;
  readonly purpose: "unsubscribe";
}

export const unsubscribeToken = (secret: string, userId: string) =>
  signPayload(secret, { uid: userId, purpose: "unsubscribe" } satisfies UnsubscribeClaim);

/** The person an unsubscribe token is for, or null when it isn't one. */
export async function unsubscribeUser(secret: string, token: string): Promise<string | null> {
  const claim = await verifyPayload<UnsubscribeClaim>(secret, token);
  return claim?.purpose === "unsubscribe" ? claim.uid : null;
}

// ---------------------------------------------------------------------------
// The email

function sentence(row: Row): string {
  const who = row.actor_name ?? "Someone";
  switch (row.kind) {
    case "mention":
      return `${who} mentioned you in ${row.file_name}`;
    case "reply":
      return `${who} replied in ${row.file_name}`;
    case "resolved":
      return `${who} resolved your comment in ${row.file_name}`;
  }
}

/** The email for one person's batch: plain text first, and an HTML twin. */
export async function notificationEmail(
  env: Env,
  person: Row,
  rows: readonly Row[],
): Promise<EmailMessage> {
  const origin = (person.origin ?? "").replace(/\/$/, "");
  const host = origin.replace(/^https?:\/\//, "");
  const token = await unsubscribeToken(env.SESSION_SECRET, person.user_id);
  const unsubscribe = `${origin}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
  const settings = `${origin}/settings`;
  const listed = rows.slice(0, LISTED);
  const more = rows.length - listed.length;
  const link = (row: Row) =>
    `${origin}/f/${encodeURIComponent(row.file_id)}?thread=${encodeURIComponent(row.thread_id)}`;
  const digest = person.pref === "daily";
  const subject =
    rows.length === 1
      ? sentence(rows[0] as Row)
      : digest
        ? `Your Drawpane digest: ${rows.length} updates`
        : `${rows.length} new comments for you in Drawpane`;
  const why = digest
    ? `You get a daily digest from Drawpane at ${host}.`
    : `You get emails about mentions and replies from Drawpane at ${host}, when you haven't seen them there.`;

  const text = [
    ...listed.flatMap((row) => [
      `${sentence(row)}:`,
      ...(row.body ? [`  “${oneLine(row.body)}”`] : []),
      `  ${link(row)}`,
      "",
    ]),
    ...(more > 0 ? [`And ${more} more in your inbox: ${origin}`, ""] : []),
    "—",
    why,
    `Change how you hear: ${settings}`,
    `Stop these emails: ${unsubscribe}`,
  ].join("\n");

  const item = (row: Row) =>
    emailRow(
      [
        emailText(sentence(row), "title"),
        row.body ? emailText(oneLine(row.body), "body", { gap: 4 }) : "",
        `<div style="margin-top:8px">${emailLink(link(row), "Open the comment →")}</div>`,
      ].join(""),
      { divider: true },
    );
  const html = emailPage({
    heading: digest
      ? "Your digest"
      : rows.length === 1
        ? "New in Drawpane"
        : `${rows.length} new comments`,
    preheader: rows[0]?.body ? oneLine(rows[0].body, 120) : undefined,
    rows: [
      ...listed.map(item),
      ...(more > 0
        ? [
            emailRow(
              `${emailText(`And ${more} more in your inbox.`, "note")}<div style="margin-top:8px">${emailLink(origin, "Open your inbox →")}</div>`,
              { divider: true },
            ),
          ]
        : []),
    ],
    footer: `${escapeHtml(why)} ${footerLink(settings, "Change how you hear")} · ${footerLink(unsubscribe, "Stop these emails")}`,
  });

  return {
    to: [person.user_email],
    subject,
    text,
    html,
    headers: {
      // One-click unsubscribe (RFC 8058): mail apps offer it, and it needs no sign-in.
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
