import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inviteEmail } from "../../src/email/invite";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { ORIGIN, signedInUser } from "../helpers";

afterEach(() => vi.restoreAllMocks());

/** What the log provider printed: one entry per email. */
function captureEmails() {
  const emails: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (String(line).startsWith("[email]")) emails.push(String(line));
  });
  return emails;
}

interface Created {
  url: string;
  email: string | null;
  emailed: boolean;
}

describe("invites by email", () => {
  it("sends the link to an address, and lists who it went to", async () => {
    const ana = await signedInUser("Ana Lima");
    const emails = captureEmails();
    const created = await ana.browser.json<Created>(`/api/teams/${ana.teamId}/invites`, {
      method: "POST",
      json: { role: "viewer", email: "  Lee@Example.COM " },
    });
    expect(created).toMatchObject({ email: "lee@example.com", emailed: true });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain("to lee@example.com: Ana Lima invited you to Team on Drawpane");
    expect(emails[0]).toContain(`Join Team: ${created.url}`);
    expect(emails[0]).toContain("as a viewer");

    const { invites, canEmail } = await ana.browser.json<{
      invites: { email: string | null; emailedAt: number | null }[];
      canEmail: boolean;
    }>(`/api/teams/${ana.teamId}/invites`);
    expect(canEmail).toBe(true);
    expect(invites[0]?.email).toBe("lee@example.com");
    expect(invites[0]?.emailedAt).toEqual(expect.any(Number));
  });

  it("still makes a working link when sending fails", async () => {
    const ana = await signedInUser("Ana Lima");
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("the mail server is down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await ana.browser.json<Created>(`/api/teams/${ana.teamId}/invites`, {
      method: "POST",
      json: { email: "lee@example.com" },
    });
    expect(created.emailed).toBe(false);
    const token = created.url.split("/invite/")[1];
    expect((await ana.browser.fetch(`/api/invites/${token}`)).status).toBe(200);
    // Nothing went out, so it doesn't count against the team's daily emails.
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM invite_emails WHERE team_id = ?")
      .bind(ana.teamId)
      .first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it("refuses an address that isn't one, or someone already on the team", async () => {
    const ana = await signedInUser("Ana Lima");
    const bo = await signedInUser("Bo Chen", "editor", ana.teamId);
    const invite = (email: string) =>
      ana.browser.fetch(`/api/teams/${ana.teamId}/invites`, { method: "POST", json: { email } });
    const bad = await invite("lee at example");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { message: "That doesn't look like an email address." },
    });
    const member = await invite(`${bo.userId.toUpperCase()}@EXAMPLE.COM`);
    expect(member.status).toBe(409);
    // Blank means a plain link, as before.
    captureEmails();
    expect(await (await invite("")).json()).toMatchObject({ email: null, emailed: false });
  });

  it("caps how many invite emails a team sends in a day, however they're taken back or raced", async () => {
    const ana = await signedInUser("Ana Lima");
    captureEmails();
    const now = Date.now();
    // 47 sent today already.
    await env.DB.batch(
      Array.from({ length: 47 }, (_, i) =>
        env.DB.prepare("INSERT INTO invite_emails (id, team_id, sent_at) VALUES (?, ?, ?)").bind(
          `cap-${ana.teamId}-${i}`,
          ana.teamId,
          now,
        ),
      ),
    );
    const send = (to: string) =>
      ana.browser.fetch(`/api/teams/${ana.teamId}/invites`, {
        method: "POST",
        json: { email: to },
      });
    // Taking one back doesn't give its email back to the cap.
    const first = await send("lee@example.com");
    expect(first.status).toBe(201);
    const { invites } = await ana.browser.json<{ invites: { id: string }[] }>(
      `/api/teams/${ana.teamId}/invites`,
    );
    await ana.browser.fetch(`/api/teams/${ana.teamId}/invites/${invites[0]?.id}`, {
      method: "DELETE",
    });
    // Five at once with two left: two go out.
    const raced = await Promise.all(["a", "b", "c", "d", "e"].map((n) => send(`${n}@example.com`)));
    expect(raced.map((r) => r.status).sort()).toEqual([201, 201, 429, 429, 429]);
    expect((await send("z@example.com")).status).toBe(429);
    // A link still works.
    expect(
      (await ana.browser.fetch(`/api/teams/${ana.teamId}/invites`, { method: "POST", json: {} }))
        .status,
    ).toBe(201);
  });

  it("says so when the instance doesn't send email", async () => {
    const ana = await signedInUser("Ana Lima");
    const off = { ...(env as Env), EMAIL_PROVIDER: "off" } as Env;
    const call = async (method: string, json?: unknown) => {
      const ctx = createExecutionContext();
      const request = new Request(`${ORIGIN}/api/teams/${ana.teamId}/invites`, {
        method,
        headers: {
          origin: ORIGIN,
          cookie: [...ana.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(json ? { "content-type": "application/json" } : {}),
        },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      const response = await worker.fetch(request, off, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    expect(await (await call("GET")).json()).toMatchObject({ canEmail: false });
    expect((await call("POST", { email: "lee@example.com" })).status).toBe(409);
  });
});

describe("the invite email", () => {
  const message = inviteEmail({
    to: "lee@example.com",
    url: "https://design.example.com/invite/abc",
    teamName: "Studio <b>&</b> Co",
    role: "editor",
    expiresAt: Date.parse("2026-11-21T12:00:00Z"),
    inviter: { name: "Ana Lima", email: "ana@example.com" },
  });

  it("is from Drawpane, with replies going to whoever invited", () => {
    expect(message.replyTo).toBe("ana@example.com");
    expect(message.subject).toBe("Ana Lima invited you to Studio <b>&</b> Co on Drawpane");
    expect(message.text).toContain("works once, until Saturday, November 21");
    expect(message.text).toContain("ana@example.com");
    expect(message.text).toContain("design.example.com");
  });

  it("escapes what people typed in its HTML", () => {
    expect(message.html).toContain("Join Studio &lt;b&gt;&amp;&lt;/b&gt; Co");
    expect(message.html).not.toContain("<b>&</b>");
    expect(message.html).toContain('href="https://design.example.com/invite/abc"');
  });
});
