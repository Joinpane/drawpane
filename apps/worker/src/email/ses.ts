/**
 * Amazon SES (API v2), signed with AWS Signature Version 4 using WebCrypto:
 * no SDK. https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
 */
import { type EmailMessage, type EmailSender, httpError } from "./message";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface SesConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The SES region, e.g. `us-east-1`. */
  readonly region: string;
  readonly from: string;
  readonly fetch?: Fetch;
  /** For tests: the signing time. */
  readonly now?: () => Date;
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(text));
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign, besides host and x-amz-date (added here). Lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly service: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly date: Date;
}

/** The headers that sign a request with SigV4: x-amz-date and Authorization. */
export async function signV4(input: SignInput): Promise<Record<string, string>> {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    input.url.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    await sha256(input.body),
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  return {
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function ses(config: SesConfig): EmailSender {
  return {
    label: `Amazon SES (${config.region})`,
    from: config.from,
    async send(message: EmailMessage) {
      const url = new URL(`https://email.${config.region}.amazonaws.com/v2/email/outbound-emails`);
      const body = JSON.stringify({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: message.to },
        ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              ...(message.html !== undefined
                ? { Html: { Data: message.html, Charset: "UTF-8" } }
                : {}),
            },
            ...(message.headers
              ? {
                  Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
          },
        },
      });
      const headers = { "content-type": "application/json" };
      const signed = await signV4({
        method: "POST",
        url,
        headers,
        body,
        service: "ses",
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        date: config.now?.() ?? new Date(),
      });
      const response = await (config.fetch ?? ((i, init) => fetch(i, init)))(url.toString(), {
        method: "POST",
        headers: { ...headers, ...signed },
        body,
      });
      if (!response.ok) throw await httpError("Amazon SES", response);
    },
  };
}
