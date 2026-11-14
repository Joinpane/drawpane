/**
 * Email, as the rest of the Worker sees it: build a message, hand it to a
 * sender. Which service carries it (Cloudflare, Resend, SMTP…) is the
 * instance's choice (setup.ts, docs/decisions/0006-email.md).
 */

export interface EmailMessage {
  /** Recipients' addresses. */
  readonly to: readonly string[];
  readonly subject: string;
  /** The plain-text body: always there, and complete on its own. */
  readonly text: string;
  /** An HTML twin of the text. */
  readonly html?: string;
  /** Extra headers, like List-Unsubscribe. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly replyTo?: string;
}

export interface EmailSender {
  /** What carries it, for people to read: "Resend", "SMTP (smtp.fastmail.com)". */
  readonly label: string;
  /** The sender, as configured: `Drawpane <design@example.com>`. */
  readonly from: string;
  send(message: EmailMessage): Promise<void>;
}

/** A message that didn't go. `retryable`: worth trying again later (a timeout, a 5xx, a rate limit). */
export class EmailError extends Error {
  override name = "EmailError";
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
  }
}

/** An HTTP answer that failed, as an EmailError: 429 and 5xx are worth retrying. */
export async function httpError(provider: string, response: Response): Promise<EmailError> {
  const body = (await response.text().catch(() => "")).slice(0, 300);
  return new EmailError(
    provider,
    `HTTP ${response.status}${body ? `: ${body}` : ""}`,
    response.status === 429 || response.status >= 500,
    response.status,
  );
}

export interface Address {
  readonly name: string | null;
  readonly email: string;
}

/** `Drawpane <design@example.com>` or `design@example.com`, as name and address; null if neither. */
export function parseAddress(text: string): Address | null {
  const trimmed = text.trim();
  const named = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
  if (named) {
    const name = (named[1] ?? "").replace(/^"(.*)"$/, "$1").trim();
    return { name: name || null, email: named[2] as string };
  }
  return /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(trimmed) ? { name: null, email: trimmed } : null;
}
