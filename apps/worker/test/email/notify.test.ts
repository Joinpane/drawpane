import { env } from "cloudflare:test";
import type { CommentThread } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  due,
  EMAIL_GRACE_MS,
  localHour,
  sendNotificationEmails,
  unsubscribeToken,
} from "../../src/email/notify";
import type { Env } from "../../src/env";
import { type Browser, ORIGIN, signedInUser } from "../helpers";

/** What the log provider printed: one entry per email. */
function captureEmails() {
  const emails: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (String(line).startsWith("[email]")) emails.push(String(line));
  });
  return emails;
}
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const ana = await signedInUser("Ana Lima");
  const bo = await signedInUser("Bo Chen", "editor", ana.teamId);
  const { file } = await ana.browser.json<{ file: { id: string } }>(
    `/api/projects/${ana.projectId}/files`,
    { method: "POST", json: { name: "Onboarding" } },
  );
  return { ana, bo, fileId: file.id };
}

const mention = (browser: Browser, fileId: string, body: string, who: string) =>
  browser
    .json<{ thread: CommentThread }>(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: { pageId: "p", x: 0, y: 0, body, mentions: [who] },
    })
    .then((r) => r.thread);

const later = () => Date.now() + EMAIL_GRACE_MS + 60_000;

describe("notification emails", () => {
  it("emails a mention still unread after a while, once, with a link to the comment", async () => {
    const { ana, bo, fileId } = await setup();
    const thread = await mention(bo.browser, fileId, "@Ana Lima <b>spacing</b>?", ana.userId);
    const emails = captureEmails();
    // Too soon: nothing.
    expect(await sendNotificationEmails(env as Env)).toEqual({ sent: 0, failed: 0 });
    expect(await sendNotificationEmails(env as Env, later())).toEqual({ sent: 1, failed: 0 });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain(
      `to ${ana.userId}@example.com: Bo Chen mentioned you in Onboarding`,
    );
    expect(emails[0]).toContain(`${ORIGIN}/f/${fileId}?thread=${thread.id}`);
    expect(emails[0]).toContain("Stop these emails:");
    // Once.
    expect(await sendNotificationEmails(env as Env, later())).toEqual({ sent: 0, failed: 0 });
  });

  it("doesn't email what's been read, or anyone who said no", async () => {
    const { ana, bo, fileId } = await setup();
    await mention(bo.browser, fileId, "Seen it already", ana.userId);
    await ana.browser.json("/api/notifications/read", { method: "POST", json: { all: true } });
    await ana.browser.json("/api/account/email", {
      method: "PUT",
      json: { notifications: "off" },
    });
    await mention(bo.browser, fileId, "And this one", ana.userId);
    const emails = captureEmails();
    expect(await sendNotificationEmails(env as Env, later())).toEqual({ sent: 0, failed: 0 });
    expect(emails).toHaveLength(0);
  });

  it("sends a daily digest at the hour picked, in the person's time zone, once", async () => {
    const { ana, bo, fileId } = await setup();
    // 9:00 in Lisbon (UTC+0 in winter).
    await ana.browser.json("/api/account/email", {
      method: "PUT",
      json: { notifications: "daily", digestHour: 9, timeZone: "Europe/Lisbon" },
    });
    await mention(bo.browser, fileId, "One", ana.userId);
    await mention(bo.browser, fileId, "Two", ana.userId);
    const emails = captureEmails();
    const at = (iso: string) => sendNotificationEmails(env as Env, Date.parse(iso));
    // The notifications are "now"; the digest runs are a day later, at various hours.
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await at(`${day}T08:30:00Z`)).toEqual({ sent: 0, failed: 0 });
    expect(await at(`${day}T09:05:00Z`)).toEqual({ sent: 1, failed: 0 });
    expect(emails[0]).toContain("Your Drawpane digest: 2 updates");
    expect(await at(`${day}T09:10:00Z`)).toEqual({ sent: 0, failed: 0 });
  });

  it("gives a notification back when sending fails for now, and gives up when it never will", async () => {
    const { ana, bo, fileId } = await setup();
    await mention(bo.browser, fileId, "Spacing?", ana.userId);
    const resend = { ...(env as Env), EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "re_test" } as Env;
    const answer = (status: number) =>
      vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response("nope", { status }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(503);
    expect(await sendNotificationEmails(resend, later())).toEqual({ sent: 0, failed: 1 });
    // Given back: the next run tries again.
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(422);
    expect(await sendNotificationEmails(resend, later())).toEqual({ sent: 0, failed: 1 });
    // A refusal that won't change: not tried again.
    expect(await sendNotificationEmails(resend, later())).toEqual({ sent: 0, failed: 0 });
    const row = await env.DB.prepare(
      "SELECT email_attempts, emailed_at FROM notifications WHERE user_id = ?",
    )
      .bind(ana.userId)
      .first<{ email_attempts: number; emailed_at: number | null }>();
    expect(row?.email_attempts).toBe(2);
    expect(row?.emailed_at).not.toBeNull();
  });

  it("knows the hour anywhere, and when a digest is due", () => {
    const noon = Date.parse("2026-11-14T12:00:00Z");
    expect(localHour(noon, "America/Los_Angeles")).toBe(4);
    expect(localHour(noon, "Asia/Tokyo")).toBe(21);
    expect(localHour(noon, "Not/AZone")).toBe(12);
    expect(
      due({ pref: "instant", digest_hour: 0, time_zone: null, last_digest_at: null }, noon),
    ).toBe(true);
    expect(due({ pref: "off", digest_hour: 12, time_zone: null, last_digest_at: null }, noon)).toBe(
      false,
    );
    expect(
      due(
        { pref: "daily", digest_hour: 12, time_zone: null, last_digest_at: noon - 3_600_000 },
        noon,
      ),
    ).toBe(false);
  });
});

describe("unsubscribing", () => {
  it("turns email off with the email's own link, no sign-in needed, and asks first on a click", async () => {
    const { ana } = await setup();
    const token = await unsubscribeToken((env as Env).SESSION_SECRET, ana.userId);
    const stranger = new (await import("../helpers")).Browser();
    // A click (GET) lands on a page that asks; it changes nothing.
    const click = await stranger.fetch(
      `/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        redirect: "manual",
      },
    );
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe(`/unsubscribe?token=${encodeURIComponent(token)}`);
    // One-click from a mail app: a POST from elsewhere, with no Origin a browser would send.
    const post = await stranger.fetch(`/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        origin: "https://mail.example.net",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "List-Unsubscribe=One-Click",
    });
    expect(post.status).toBe(200);
    expect(await ana.browser.json("/api/account/email")).toMatchObject({ notifications: "off" });
    const forged = await stranger.fetch("/api/email/unsubscribe?token=nope", { method: "POST" });
    expect(forged.status).toBe(404);
  });

  it("keeps preferences valid", async () => {
    const { ana } = await setup();
    expect(await ana.browser.json("/api/account/email")).toEqual({
      notifications: "instant",
      digestHour: 9,
      timeZone: null,
      available: true,
    });
    const bad = await ana.browser.fetch("/api/account/email", {
      method: "PUT",
      json: { notifications: "daily", timeZone: "Mars/Olympus" },
    });
    expect(bad.status).toBe(400);
  });
});
