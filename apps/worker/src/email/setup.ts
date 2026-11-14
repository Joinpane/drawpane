/**
 * Which way this instance sends email, from its vars and secrets
 * (docs/decisions/0006-email.md, docs/self-hosting.md):
 *
 * - `EMAIL_PROVIDER`: `off` (the default), `cloudflare`, `resend`,
 *   `postmark`, `sendgrid`, `mailgun`, `ses`, `smtp`, or `log` (development:
 *   printed, not sent).
 * - `EMAIL_FROM`: who it's from, `Drawpane <design@example.com>`.
 * - The provider's credentials, as secrets: `EMAIL_API_KEY` (Resend,
 *   Postmark, SendGrid, Mailgun; `MAILGUN_DOMAIN` and `MAILGUN_REGION=eu`
 *   optional), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`
 *   (SES), `SMTP_URL` (SMTP), or a `send_email` binding named `EMAIL`.
 *
 * Anything missing or wrong is said plainly, for the health page; it never
 * throws.
 */
import type { Env } from "../env";
import { cloudflareEmail } from "./cloudflare";
import { mailgun, postmark, resend, sendgrid } from "./http-providers";
import { type EmailSender, parseAddress } from "./message";
import { ses } from "./ses";
import { parseSmtpUrl, smtp } from "./smtp";

export const EMAIL_PROVIDERS = [
  "off",
  "cloudflare",
  "resend",
  "postmark",
  "sendgrid",
  "mailgun",
  "ses",
  "smtp",
  "log",
] as const;

export type EmailSetup =
  | { readonly sender: EmailSender; readonly problem: null }
  /** Off (problem null), or set up but not right (problem says what to fix). */
  | { readonly sender: null; readonly problem: string | null };

const off = (problem: string | null): EmailSetup => ({ sender: null, problem });

export function emailSetup(env: Env): EmailSetup {
  const provider = (env.EMAIL_PROVIDER ?? "off").trim().toLowerCase();
  if (provider === "off" || provider === "") return off(null);
  if (!(EMAIL_PROVIDERS as readonly string[]).includes(provider))
    return off(
      `EMAIL_PROVIDER is "${provider}". Use one of: ${EMAIL_PROVIDERS.filter((p) => p !== "off").join(", ")}, or off.`,
    );
  const from = env.EMAIL_FROM?.trim() ?? "";
  if (!parseAddress(from))
    return off(
      "Set EMAIL_FROM to the address emails come from, like Drawpane <design@example.com>.",
    );
  const key = env.EMAIL_API_KEY?.trim();
  const needKey = (name: string) =>
    off(
      `Set the EMAIL_API_KEY secret to your ${name} API key (npx wrangler secret put EMAIL_API_KEY).`,
    );
  const ok = (sender: EmailSender): EmailSetup => ({ sender, problem: null });
  switch (provider) {
    case "cloudflare":
      return env.EMAIL
        ? ok(cloudflareEmail(env.EMAIL, from))
        : off('Add a send_email binding named "EMAIL" to the Worker for Cloudflare Email Service.');
    case "resend":
      return key ? ok(resend({ apiKey: key, from })) : needKey("Resend");
    case "postmark":
      return key ? ok(postmark({ apiKey: key, from })) : needKey("Postmark server");
    case "sendgrid":
      return key ? ok(sendgrid({ apiKey: key, from })) : needKey("SendGrid");
    case "mailgun":
      return key
        ? ok(
            mailgun({
              apiKey: key,
              from,
              ...(env.MAILGUN_DOMAIN ? { domain: env.MAILGUN_DOMAIN } : {}),
              ...(env.MAILGUN_REGION ? { region: env.MAILGUN_REGION.toLowerCase() } : {}),
            }),
          )
        : needKey("Mailgun");
    case "ses":
      return env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION
        ? ok(
            ses({
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              region: env.AWS_REGION,
              from,
            }),
          )
        : off(
            "Amazon SES needs AWS_REGION, and the AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY secrets of a user allowed ses:SendEmail.",
          );
    case "smtp": {
      const config = env.SMTP_URL ? parseSmtpUrl(env.SMTP_URL, from) : null;
      return config
        ? ok(smtp(config))
        : off(
            "Set the SMTP_URL secret, like smtp://user:password@smtp.example.com:587 (or smtps:// on port 465).",
          );
    }
    case "log":
      return ok({
        label: "Log (development: printed, not sent)",
        from,
        async send(message) {
          console.log(`[email] to ${message.to.join(", ")}: ${message.subject}\n${message.text}`);
        },
      });
    default:
      return off(null);
  }
}
