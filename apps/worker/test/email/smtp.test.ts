import { describe, expect, it } from "vitest";
import { dotStuff, parseSmtpUrl, type SmtpTransport, smtp } from "../../src/email/smtp";

/**
 * A mail server reading from a script: for each command the client sends
 * (matched by its start), the lines it answers. Records what it was sent,
 * and when the connection went to TLS.
 */
function server(greeting: string, script: Array<[string, string[]]>) {
  const sent: string[] = [];
  const queue: string[] = [greeting];
  let pending = "";
  let tlsAt = -1;
  let closed = false;
  const transport: SmtpTransport = {
    async readLine() {
      return queue.shift() ?? null;
    },
    async write(text) {
      pending += text;
      // Data ends with CRLF.CRLF; commands with CRLF.
      for (;;) {
        if (sent.at(-1) === "DATA" && !pending.includes("\r\n.\r\n")) return;
        const end =
          sent.at(-1) === "DATA" ? pending.indexOf("\r\n.\r\n") + 5 : pending.indexOf("\r\n") + 2;
        if (end < 2) return;
        const chunk = pending.slice(0, end - 2);
        pending = pending.slice(end);
        const command = sent.at(-1) === "DATA" ? `<data>${chunk}` : chunk;
        sent.push(command);
        const step = script.find(([start]) => command.startsWith(start));
        if (!step) throw new Error(`unexpected: ${command}`);
        script.splice(script.indexOf(step), 1);
        queue.push(...step[1]);
        if (!pending) return;
      }
    },
    async startTls() {
      tlsAt = sent.length;
    },
    async close() {
      closed = true;
    },
  };
  return { transport, sent, tls: () => tlsAt, closed: () => closed };
}

const config = (url: string, transport: SmtpTransport) => ({
  ...(parseSmtpUrl(url, "Drawpane <design@example.com>") as NonNullable<
    ReturnType<typeof parseSmtpUrl>
  >),
  connect: async () => transport,
  timeoutMs: 1000,
});

const message = {
  to: ["ana@example.com", "bo@example.com"],
  subject: "Lena mentioned you",
  text: "Spacing?\n.\nA line that's just a dot.",
};

describe("SMTP", () => {
  it("upgrades with STARTTLS before signing in, then sends to everyone", async () => {
    const s = server("220 mail.example.com ESMTP", [
      ["EHLO", ["250-mail.example.com", "250-STARTTLS", "250 SIZE 10240000"]],
      ["STARTTLS", ["220 Go ahead"]],
      ["EHLO", ["250-mail.example.com", "250-AUTH PLAIN LOGIN", "250 OK"]],
      ["AUTH PLAIN", ["235 Authenticated"]],
      ["MAIL FROM:<design@example.com>", ["250 OK"]],
      ["RCPT TO:<ana@example.com>", ["250 OK"]],
      ["RCPT TO:<bo@example.com>", ["250 OK"]],
      ["DATA", ["354 Go"]],
      ["<data>", ["250 Queued"]],
      ["QUIT", ["221 Bye"]],
    ]);
    await smtp(config("smtp://me%40example.com:p%40ss@mail.example.com:587", s.transport)).send(
      message,
    );
    // TLS came right after STARTTLS, before the credentials.
    expect(s.sent[s.tls() - 1]).toBe("STARTTLS");
    expect(s.sent.findIndex((c) => c.startsWith("AUTH"))).toBeGreaterThan(s.tls());
    expect(s.sent.find((c) => c.startsWith("AUTH PLAIN"))).toBe(
      `AUTH PLAIN ${btoa("\0me@example.com\0p@ss")}`,
    );
    const data = s.sent.find((c) => c.startsWith("<data>")) ?? "";
    expect(data).toContain("Subject: Lena mentioned you");
    expect(s.closed()).toBe(true);
  });

  it("won't send credentials over a connection that can't be encrypted", async () => {
    const s = server("220 old.example.com", [["EHLO", ["250 old.example.com"]]]);
    await expect(
      smtp(config("smtp://me:pw@old.example.com", s.transport)).send(message),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/STARTTLS/) });
    expect(s.sent.some((c) => c.startsWith("AUTH"))).toBe(false);
  });

  it("speaks TLS from the start on smtps, and falls back to AUTH LOGIN", async () => {
    const s = server("220 ok", [
      ["EHLO", ["250-ok", "250 AUTH LOGIN"]],
      ["AUTH LOGIN", ["334 VXNlcm5hbWU6"]],
      [btoa("me"), ["334 UGFzc3dvcmQ6"]],
      [btoa("pw"), ["235 OK"]],
      ["MAIL FROM", ["250 OK"]],
      ["RCPT TO", ["250 OK"]],
      ["RCPT TO", ["250 OK"]],
      ["DATA", ["354 Go"]],
      ["<data>", ["250 OK"]],
      ["QUIT", ["221 Bye"]],
    ]);
    const c = config("smtps://me:pw@mail.example.com", s.transport);
    expect(c.port).toBe(465);
    await smtp(c).send(message);
    expect(s.tls()).toBe(-1);
    expect(s.sent).not.toContain("STARTTLS");
  });

  it("tells a temporary refusal from a permanent one", async () => {
    const reject = (code: string) =>
      server("220 ok", [
        ["EHLO", ["250-ok", "250 STARTTLS"]],
        ["STARTTLS", ["220 Go"]],
        ["EHLO", ["250 ok"]],
        ["MAIL FROM", ["250 OK"]],
        ["RCPT TO", [`${code} No`]],
        ["QUIT", ["221 Bye"]],
      ]);
    const noAuth = (t: SmtpTransport) => config("smtp://mail.example.com", t);
    await expect(smtp(noAuth(reject("451").transport)).send(message)).rejects.toMatchObject({
      retryable: true,
      status: 451,
    });
    await expect(smtp(noAuth(reject("550").transport)).send(message)).rejects.toMatchObject({
      retryable: false,
      status: 550,
    });
  });

  it("doubles a dot that starts a line, so it isn't read as the end", () => {
    expect(dotStuff("a\n.\n.b\nc")).toBe("a\r\n..\r\n..b\r\nc");
  });

  it("reads smtp and smtps URLs, and nothing else", () => {
    expect(parseSmtpUrl("smtp://mail.example.com", "a@b.co")).toMatchObject({
      port: 587,
      secure: false,
      user: null,
    });
    expect(parseSmtpUrl("https://mail.example.com", "a@b.co")).toBeNull();
    expect(parseSmtpUrl("not a url", "a@b.co")).toBeNull();
  });
});
