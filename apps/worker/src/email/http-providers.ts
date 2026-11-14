/**
 * Transactional email services with an HTTPS API and a key: Resend,
 * Postmark, SendGrid and Mailgun. Each turns a message into its own request;
 * an error answer becomes an EmailError (retryable on 429 and 5xx).
 */
import { type EmailMessage, type EmailSender, httpError, parseAddress } from "./message";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface KeyConfig {
  readonly apiKey: string;
  readonly from: string;
  /** For tests; the global fetch otherwise. */
  readonly fetch?: Fetch;
}

const send = (config: KeyConfig): Fetch => config.fetch ?? ((input, init) => fetch(input, init));

/** Resend: https://resend.com/docs/api-reference/emails/send-email */
export function resend(config: KeyConfig): EmailSender {
  return {
    label: "Resend",
    from: config.from,
    async send(message: EmailMessage) {
      const response = await send(config)("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html !== undefined ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
        }),
      });
      if (!response.ok) throw await httpError("Resend", response);
    },
  };
}

/** Postmark: https://postmarkapp.com/developer/api/email-api */
export function postmark(config: KeyConfig): EmailSender {
  return {
    label: "Postmark",
    from: config.from,
    async send(message: EmailMessage) {
      const response = await send(config)("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-postmark-server-token": config.apiKey,
        },
        body: JSON.stringify({
          From: config.from,
          To: message.to.join(", "),
          Subject: message.subject,
          TextBody: message.text,
          ...(message.html !== undefined ? { HtmlBody: message.html } : {}),
          ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
          ...(message.headers
            ? {
                Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
              }
            : {}),
          MessageStream: "outbound",
        }),
      });
      if (!response.ok) throw await httpError("Postmark", response);
    },
  };
}

/** SendGrid: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send */
export function sendgrid(config: KeyConfig): EmailSender {
  const from = parseAddress(config.from);
  return {
    label: "SendGrid",
    from: config.from,
    async send(message: EmailMessage) {
      const response = await send(config)("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: message.to.map((email) => ({ email })) }],
          from: from?.name ? { email: from.email, name: from.name } : { email: from?.email },
          subject: message.subject,
          // SendGrid wants plain text first.
          content: [
            { type: "text/plain", value: message.text },
            ...(message.html !== undefined ? [{ type: "text/html", value: message.html }] : []),
          ],
          ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
        }),
      });
      if (!response.ok) throw await httpError("SendGrid", response);
    },
  };
}

interface MailgunConfig extends KeyConfig {
  /** The sending domain, as set up in Mailgun; the From address's domain when not given. */
  readonly domain?: string;
  /** `eu` for Mailgun's EU region. */
  readonly region?: string;
}

/** Mailgun: https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages */
export function mailgun(config: MailgunConfig): EmailSender {
  const domain = config.domain ?? parseAddress(config.from)?.email.split("@")[1] ?? "";
  const host = config.region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
  return {
    label: `Mailgun (${domain})`,
    from: config.from,
    async send(message: EmailMessage) {
      const form = new FormData();
      form.set("from", config.from);
      for (const to of message.to) form.append("to", to);
      form.set("subject", message.subject);
      form.set("text", message.text);
      if (message.html !== undefined) form.set("html", message.html);
      if (message.replyTo) form.set("h:Reply-To", message.replyTo);
      for (const [name, value] of Object.entries(message.headers ?? {}))
        form.set(`h:${name}`, value);
      const response = await send(config)(
        `https://${host}/v3/${encodeURIComponent(domain)}/messages`,
        {
          method: "POST",
          headers: { authorization: `Basic ${btoa(`api:${config.apiKey}`)}` },
          body: form,
        },
      );
      if (!response.ok) throw await httpError("Mailgun", response);
    },
  };
}
