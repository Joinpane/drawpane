import { describe, expect, it } from "vitest";
import { cloudflareEmail } from "../../src/email/cloudflare";
import { mailgun, postmark, resend, sendgrid } from "../../src/email/http-providers";
import { type EmailMessage, parseAddress } from "../../src/email/message";
import { buildMime, headerAddress, headerText } from "../../src/email/mime";
import { emailSetup } from "../../src/email/setup";
import type { Env } from "../../src/env";

/** The one request a provider made; fails the test if there wasn't exactly one. */
function sentOne<T>(calls: readonly T[]): T {
  expect(calls).toHaveLength(1);
  return calls[0] as T;
}

const FROM = "Drawpane <design@example.com>";
const message: EmailMessage = {
  to: ["ana@example.com"],
  subject: "Lena mentioned you",
  text: "Spacing?",
  html: "<p>Spacing?</p>",
  headers: { "List-Unsubscribe": "<https://x/u>" },
};

/** A fetch that records the request and answers `status`. */
function recorder(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  };
  return { calls, fetch };
}

describe("HTTP providers", () => {
  it("Resend: bearer key, JSON with text, HTML and headers", async () => {
    const r = recorder();
    await resend({ apiKey: "re_key", from: FROM, fetch: r.fetch }).send(message);
    const call = sentOne(r.calls);
    expect(call.url).toBe("https://api.resend.com/emails");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(call.init.body as string)).toEqual({
      from: FROM,
      to: ["ana@example.com"],
      subject: "Lena mentioned you",
      text: "Spacing?",
      html: "<p>Spacing?</p>",
      headers: { "List-Unsubscribe": "<https://x/u>" },
    });
  });

  it("Postmark: server token, its field names, the outbound stream", async () => {
    const r = recorder();
    await postmark({ apiKey: "pm_key", from: FROM, fetch: r.fetch }).send(message);
    const call = sentOne(r.calls);
    expect(call.url).toBe("https://api.postmarkapp.com/email");
    expect((call.init.headers as Record<string, string>)["x-postmark-server-token"]).toBe("pm_key");
    expect(JSON.parse(call.init.body as string)).toEqual({
      From: FROM,
      To: "ana@example.com",
      Subject: "Lena mentioned you",
      TextBody: "Spacing?",
      HtmlBody: "<p>Spacing?</p>",
      Headers: [{ Name: "List-Unsubscribe", Value: "<https://x/u>" }],
      MessageStream: "outbound",
    });
  });

  it("SendGrid: personalizations, a named sender, plain text first", async () => {
    const r = recorder(202);
    await sendgrid({ apiKey: "SG.key", from: FROM, fetch: r.fetch }).send(message);
    const body = JSON.parse(r.calls[0]?.init.body as string);
    expect(r.calls[0]?.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(body.personalizations).toEqual([{ to: [{ email: "ana@example.com" }] }]);
    expect(body.from).toEqual({ email: "design@example.com", name: "Drawpane" });
    expect(body.content.map((c: { type: string }) => c.type)).toEqual(["text/plain", "text/html"]);
  });

  it("Mailgun: basic auth, the sending domain and region, h: headers", async () => {
    const r = recorder();
    await mailgun({ apiKey: "mg_key", from: FROM, region: "eu", fetch: r.fetch }).send(message);
    const call = sentOne(r.calls);
    expect(call.url).toBe("https://api.eu.mailgun.net/v3/example.com/messages");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa("api:mg_key")}`,
    );
    const form = call.init.body as FormData;
    expect(form.getAll("to")).toEqual(["ana@example.com"]);
    expect(form.get("h:List-Unsubscribe")).toBe("<https://x/u>");
    expect(form.get("html")).toBe("<p>Spacing?</p>");
  });

  it("says which answers are worth retrying", async () => {
    const send = (status: number) =>
      resend({ apiKey: "k", from: FROM, fetch: recorder(status).fetch }).send(message);
    await expect(send(429)).rejects.toMatchObject({ retryable: true });
    await expect(send(500)).rejects.toMatchObject({ retryable: true });
    await expect(send(422)).rejects.toMatchObject({ retryable: false, status: 422 });
  });
});

describe("Cloudflare Email Service", () => {
  it("sends one message per person, as raw mail from the bare address", async () => {
    const sent: { from: string; to: string; raw: string }[] = [];
    const sender = cloudflareEmail(
      { send: async (m) => void sent.push(m as { from: string; to: string; raw: string }) },
      FROM,
      async (from, to, raw) => ({ from, to, raw }),
    );
    await sender.send({ ...message, to: ["ana@example.com", "bo@example.com"] });
    expect(sent.map((m) => [m.from, m.to])).toEqual([
      ["design@example.com", "ana@example.com"],
      ["design@example.com", "bo@example.com"],
    ]);
    // Each sees only their own address.
    expect(sent[1]?.raw).toContain("To: bo@example.com\r\n");
    expect(sent[1]?.raw).not.toContain("ana@example.com");
  });
});

describe("MIME", () => {
  it("writes headers, and text and HTML as base64 UTF-8 alternatives", () => {
    const raw = buildMime(
      { ...message, subject: "Lena a commenté « Accueil »", text: "Ça va ?" },
      {
        from: "Équipe Design <design@example.com>",
        messageId: "<1@example.com>",
        date: new Date(0),
      },
    );
    const [head, body] = raw.split("\r\n\r\n");
    expect(head).toContain(`From: ${headerText("Équipe Design")} <design@example.com>`);
    expect(head).toContain(
      `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("Lena a commenté « Accueil »")))}?=`,
    );
    expect(head).toContain("Message-ID: <1@example.com>");
    expect(head).toContain("List-Unsubscribe: <https://x/u>");
    expect(head).toMatch(/Content-Type: multipart\/alternative; boundary="=_[0-9a-f]+"/);
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("Content-Type: text/html; charset=utf-8");
    expect(body).toBeDefined();
    // The text survives the round trip.
    const text =
      raw
        .split(
          "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
        )[1]
        ?.split("\r\n--")[0] ?? "";
    expect(
      new TextDecoder().decode(
        Uint8Array.from(atob(text.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)),
      ),
    ).toBe("Ça va ?");
  });

  it("can't be given a header of its own through a line break", () => {
    const raw = buildMime(
      { to: ["ana@example.com"], subject: "Hi\r\nBcc: everyone@example.com", text: "x" },
      { from: FROM },
    );
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it("quotes or encodes names as headers need", () => {
    expect(headerAddress({ name: "Drawpane", email: "a@b.co" })).toBe("Drawpane <a@b.co>");
    expect(headerAddress({ name: "Ana, Design", email: "a@b.co" })).toBe('"Ana, Design" <a@b.co>');
    expect(headerAddress({ name: null, email: "a@b.co" })).toBe("a@b.co");
    expect(parseAddress("Drawpane <design@example.com>")).toEqual({
      name: "Drawpane",
      email: "design@example.com",
    });
    expect(parseAddress("not an address")).toBeNull();
  });
});

describe("email setup", () => {
  const env = (vars: Partial<Env>) => vars as Env;
  it("is off unless asked for, and says plainly what's missing", () => {
    expect(emailSetup(env({}))).toEqual({ sender: null, problem: null });
    expect(emailSetup(env({ EMAIL_PROVIDER: "carrier-pigeon" })).problem).toMatch(
      /Use one of: cloudflare, resend/,
    );
    expect(emailSetup(env({ EMAIL_PROVIDER: "resend" })).problem).toMatch(/EMAIL_FROM/);
    expect(emailSetup(env({ EMAIL_PROVIDER: "resend", EMAIL_FROM: FROM })).problem).toMatch(
      /EMAIL_API_KEY/,
    );
    expect(emailSetup(env({ EMAIL_PROVIDER: "ses", EMAIL_FROM: FROM })).problem).toMatch(
      /AWS_REGION/,
    );
    expect(
      emailSetup(env({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: FROM, SMTP_URL: "mail.example.com" }))
        .problem,
    ).toMatch(/SMTP_URL/);
    expect(emailSetup(env({ EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: FROM })).problem).toMatch(
      /send_email binding/,
    );
  });

  it("builds the sender for each provider", () => {
    const labels = [
      { EMAIL_PROVIDER: "Resend", EMAIL_API_KEY: "k" },
      { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "k" },
      { EMAIL_PROVIDER: "sendgrid", EMAIL_API_KEY: "k" },
      { EMAIL_PROVIDER: "mailgun", EMAIL_API_KEY: "k", MAILGUN_DOMAIN: "mg.example.com" },
      {
        EMAIL_PROVIDER: "ses",
        AWS_ACCESS_KEY_ID: "a",
        AWS_SECRET_ACCESS_KEY: "b",
        AWS_REGION: "eu-west-1",
      },
      { EMAIL_PROVIDER: "smtp", SMTP_URL: "smtps://u:p@mail.example.com" },
      { EMAIL_PROVIDER: "cloudflare", EMAIL: { send: async () => {} } },
      { EMAIL_PROVIDER: "log" },
    ].map((vars) => emailSetup(env({ EMAIL_FROM: FROM, ...vars })).sender?.label);
    expect(labels).toEqual([
      "Resend",
      "Postmark",
      "SendGrid",
      "Mailgun (mg.example.com)",
      "Amazon SES (eu-west-1)",
      "SMTP (mail.example.com)",
      "Cloudflare Email Service",
      "Log (development: printed, not sent)",
    ]);
  });
});
