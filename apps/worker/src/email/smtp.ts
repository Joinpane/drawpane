/**
 * SMTP, for any mail server people already have (Google Workspace,
 * Microsoft 365, Fastmail, their own), over a Worker's TCP socket.
 *
 * Configured with one URL: `smtp://user:pass@smtp.example.com:587` upgrades
 * to TLS with STARTTLS (and refuses to send credentials if the server can't);
 * `smtps://…:465` is TLS from the start. The protocol runs over a small
 * transport interface, so it's tested against a scripted server.
 */

import { EmailError, type EmailMessage, type EmailSender, parseAddress } from "./message";
import { buildMime } from "./mime";

/** A connection to a mail server: lines in, text out, and an upgrade to TLS. */
export interface SmtpTransport {
  /** The next line from the server, without its line break; null when it closed. */
  readLine(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** Switches the connection to TLS (after STARTTLS). */
  startTls(): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** TLS from the start (port 465), rather than STARTTLS. */
  readonly secure: boolean;
  readonly user: string | null;
  readonly pass: string | null;
  readonly from: string;
  /** Opens the connection; a Worker socket by default. */
  readonly connect?: (config: SmtpConfig) => Promise<SmtpTransport>;
  /** How long to wait for the server's answers, in ms. */
  readonly timeoutMs?: number;
}

/** `smtp://user:pass@host:587` or `smtps://…:465`, as SmtpConfig; null if it isn't one. */
export function parseSmtpUrl(text: string, from: string): SmtpConfig | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return null;
  const secure = url.protocol === "smtps:";
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    user: url.username ? decodeURIComponent(url.username) : null,
    pass: url.password ? decodeURIComponent(url.password) : null,
    from,
  };
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** One SMTP conversation: replies, and commands that expect a reply. */
class Conversation {
  constructor(
    readonly transport: SmtpTransport,
    readonly host: string,
    readonly timeoutMs: number,
  ) {}

  /** The next reply, all its lines (`250-…` continues, `250 …` ends). */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.#withTimeout(this.transport.readLine());
      if (line === null) throw this.#fail("the server closed the connection", true);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) throw this.#fail(`unexpected reply "${line}"`, false);
      lines.push(match[3] as string);
      if (match[2] === " ") return { code: Number(match[1]), lines };
    }
  }

  /** Sends a command (without its line break) and checks the reply is one of `expect`. */
  async command(text: string, expect: readonly number[], shown = text): Promise<Reply> {
    await this.transport.write(`${text}\r\n`);
    return this.expect(expect, shown);
  }

  async expect(expect: readonly number[], what: string): Promise<Reply> {
    const reply = await this.reply();
    if (!expect.includes(reply.code))
      throw this.#fail(
        `${what} answered ${reply.code} ${reply.lines.join(" ")}`,
        reply.code >= 400 && reply.code < 500,
        reply.code,
      );
    return reply;
  }

  #fail(message: string, retryable: boolean, status?: number): EmailError {
    return new EmailError(`SMTP (${this.host})`, message, retryable, status);
  }

  #withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(this.#fail(`no answer in ${this.timeoutMs / 1000} s`, true)),
        this.timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

/** A message's lines ready for DATA: CRLF throughout, and a line starting with "." doubled. */
export function dotStuff(mime: string): string {
  return mime.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

export function smtp(config: SmtpConfig): EmailSender {
  const from = parseAddress(config.from);
  return {
    label: `SMTP (${config.host})`,
    from: config.from,
    async send(message: EmailMessage) {
      if (!from) throw new EmailError("SMTP", `not an address: ${config.from}`, false);
      const transport = await (config.connect ?? connectSocket)(config);
      const talk = new Conversation(transport, config.host, config.timeoutMs ?? 20_000);
      const hello = `EHLO ${from.email.split("@")[1] ?? "localhost"}`;
      try {
        await talk.expect([220], "the greeting");
        let ehlo = await talk.command(hello, [250]);
        if (!config.secure) {
          // Credentials and mail only travel encrypted.
          if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l)))
            throw new EmailError(
              `SMTP (${config.host})`,
              "the server doesn't offer STARTTLS; use smtps:// on port 465 if it takes TLS from the start",
              false,
            );
          await talk.command("STARTTLS", [220]);
          await transport.startTls();
          ehlo = await talk.command(hello, [250]);
        }
        if (config.user !== null) {
          const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) ?? "";
          if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
            const token = btoa(`\0${config.user}\0${config.pass ?? ""}`);
            await talk.command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
          } else {
            await talk.command("AUTH LOGIN", [334]);
            await talk.command(btoa(config.user), [334], "the user name");
            await talk.command(btoa(config.pass ?? ""), [235], "the password");
          }
        }
        await talk.command(`MAIL FROM:<${from.email}>`, [250]);
        for (const to of message.to) await talk.command(`RCPT TO:<${to}>`, [250, 251]);
        await talk.command("DATA", [354]);
        await transport.write(`${dotStuff(buildMime(message, { from: config.from }))}\r\n.\r\n`);
        await talk.expect([250], "the message");
        await talk.command("QUIT", [221]).catch(() => {});
      } finally {
        await transport.close().catch(() => {});
      }
    },
  };
}

/** A Worker TCP socket (cloudflare:sockets) as an SmtpTransport. */
async function connectSocket(config: SmtpConfig): Promise<SmtpTransport> {
  const { connect } = await import("cloudflare:sockets");
  let socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.secure ? "on" : "starttls", allowHalfOpen: false },
  );
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return {
    async readLine() {
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async write(text) {
      await writer.write(encoder.encode(text));
    },
    async startTls() {
      // Anything already read arrived in the clear after "ready to start TLS": a
      // man in the middle answering for the server. Never read it as the server's.
      if (buffer !== "") throw new Error("The SMTP server sent data before TLS started.");
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    },
    async close() {
      await socket.close();
    },
  };
}
