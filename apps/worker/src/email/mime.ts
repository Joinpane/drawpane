/**
 * A message as raw RFC 5322 text, for the ways of sending that take mail as
 * it travels (Cloudflare's send_email binding, SMTP): headers, then plain
 * text and HTML as multipart/alternative. Bodies are base64 so any text,
 * in any language, arrives intact; non-ASCII headers use RFC 2047 words.
 */
import { type Address, type EmailMessage, parseAddress } from "./message";

const CRLF = "\r\n";

/** UTF-8 bytes as base64, wrapped at 76 characters as MIME asks. */
function base64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return (btoa(binary).match(/.{1,76}/g) ?? [""]).join(CRLF);
}

/** A header value, as an RFC 2047 encoded word when it isn't plain ASCII. */
export function headerText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** An address for a header: the name encoded when it needs to be, and quoted when it has specials. */
export function headerAddress(address: Address): string {
  if (!address.name) return address.email;
  const name = headerText(address.name);
  const quoted =
    name.startsWith("=?") || !/[(),.:;<>@[\]\\"]/.test(name)
      ? name
      : `"${name.replace(/["\\]/g, "\\$&")}"`;
  return `${quoted} <${address.email}>`;
}

/** Header names and values can't carry line breaks: one could start a header of its own. */
const clean = (value: string) => value.replace(/[\r\n]+/g, " ");

export interface MimeOptions {
  readonly from: string;
  /** Unique per message; made from the sender's domain when not given. */
  readonly messageId?: string;
  readonly date?: Date;
}

export function buildMime(message: EmailMessage, options: MimeOptions): string {
  const from = parseAddress(options.from);
  if (!from) throw new Error(`Not an email address: ${options.from}`);
  const domain = from.email.split("@")[1] ?? "localhost";
  const id = options.messageId ?? `<${crypto.randomUUID()}@${domain}>`;
  const headers: [string, string][] = [
    ["From", headerAddress(from)],
    ["To", message.to.map(clean).join(", ")],
    ["Subject", headerText(clean(message.subject))],
    ["Date", (options.date ?? new Date()).toUTCString().replace("GMT", "+0000")],
    ["Message-ID", id],
    ["MIME-Version", "1.0"],
  ];
  if (message.replyTo) headers.push(["Reply-To", clean(message.replyTo)]);
  for (const [name, value] of Object.entries(message.headers ?? {}))
    headers.push([clean(name), headerText(clean(value))]);

  const part = (type: string, body: string) =>
    [
      `Content-Type: ${type}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(body),
    ].join(CRLF);

  let body: string;
  if (message.html === undefined) {
    headers.push(
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Content-Transfer-Encoding", "base64"],
    );
    body = base64Lines(message.text);
  } else {
    const boundary = `=_${crypto.randomUUID().replace(/-/g, "")}`;
    headers.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);
    body = [
      `--${boundary}`,
      part("text/plain", message.text),
      `--${boundary}`,
      part("text/html", message.html),
      `--${boundary}--`,
      "",
    ].join(CRLF);
  }
  return `${headers.map(([n, v]) => `${n}: ${v}`).join(CRLF)}${CRLF}${CRLF}${body}`;
}
