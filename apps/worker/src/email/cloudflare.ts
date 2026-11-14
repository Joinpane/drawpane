/**
 * Cloudflare Email Service, through a `send_email` binding: no key, the
 * binding is the credential. It takes mail as it travels (RFC 5322), one
 * recipient per message. Sending to anyone needs a sending domain
 * onboarded with Cloudflare; before that, only verified addresses
 * (https://developers.cloudflare.com/email-service/).
 */

import { EmailError, type EmailMessage, type EmailSender, parseAddress } from "./message";
import { buildMime } from "./mime";

/** The binding's shape: what `send_email` gives a Worker. */
export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

/** Builds the message object the binding takes: cloudflare:email's EmailMessage by default. */
type MakeMessage = (from: string, to: string, raw: string) => Promise<unknown>;

const emailMessage: MakeMessage = async (from, to, raw) => {
  const { EmailMessage } = await import("cloudflare:email");
  return new EmailMessage(from, to, raw);
};

export function cloudflareEmail(
  binding: SendEmailBinding,
  from: string,
  make: MakeMessage = emailMessage,
): EmailSender {
  const sender = parseAddress(from)?.email ?? from;
  return {
    label: "Cloudflare Email Service",
    from,
    async send(message: EmailMessage) {
      // One message per person: each sees only their own address.
      for (const to of message.to) {
        const raw = buildMime({ ...message, to: [to] }, { from });
        try {
          await binding.send(await make(sender, to, raw));
        } catch (error) {
          throw new EmailError(
            "Cloudflare Email Service",
            error instanceof Error ? error.message : String(error),
            // A bad address or an unverified destination won't change on its own.
            !/destination|not allowed|invalid/i.test(String(error)),
          );
        }
      }
    },
  };
}
