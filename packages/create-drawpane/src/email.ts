/**
 * Email for an instance (docs/decisions/0006-email.md): the ways it can send,
 * what each needs, and turning answers into the Worker's secrets. The Worker
 * reads the same names (apps/worker/src/email/setup.ts); a test keeps the two
 * in step. Pure: the flow that asks and deploys is `configureEmail` in flows.ts.
 */
import { Problem } from "./problem.js";

/** Every secret the email setup manages. Others on the Worker are never touched. */
export const EMAIL_SECRETS = [
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "EMAIL_API_KEY",
  "MAILGUN_DOMAIN",
  "MAILGUN_REGION",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "SMTP_URL",
] as const;
export type EmailSecret = (typeof EMAIL_SECRETS)[number];
export type EmailSecrets = Partial<Record<EmailSecret, string>>;

export type ProviderId =
  | "cloudflare"
  | "resend"
  | "postmark"
  | "sendgrid"
  | "mailgun"
  | "ses"
  | "smtp";

/** One question about a provider. `key` is a secret's name, or the provider's own (SMTP's parts). */
export type Field =
  | {
      readonly kind: "text" | "secret";
      readonly key: string;
      readonly message: string;
      readonly placeholder?: string;
      readonly initial?: string;
      /** Blank is fine (the Worker has a default). */
      readonly optional?: boolean;
      readonly validate?: (value: string) => string | null;
    }
  | {
      readonly kind: "select";
      readonly key: string;
      readonly message: string;
      readonly options: readonly { value: string; label: string; hint?: string }[];
    };

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** What it takes, in a few words, beside its name in the list. */
  readonly hint: string;
  /** Said before its questions: what to have ready, or to do first. */
  readonly before?: string;
  readonly fields: readonly Field[];
  /** The secrets, besides EMAIL_PROVIDER and EMAIL_FROM, a working setup needs. */
  readonly requires: readonly EmailSecret[];
  /** Answers as secrets (by default, each answered field whose key is a secret's name). */
  readonly secrets?: (answers: Readonly<Record<string, string>>) => EmailSecrets;
}

const required = (what: string) => (value: string) => (value ? null : `Enter ${what}.`);

const apiKey = (name: string, placeholder?: string): Field => ({
  kind: "secret",
  key: "EMAIL_API_KEY",
  message: `${name}`,
  ...(placeholder ? { placeholder } : {}),
  validate: (v) => (v ? (/\s/.test(v) ? "A key has no spaces." : null) : `Paste the ${name}.`),
});

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const PROVIDERS: readonly Provider[] = [
  {
    id: "resend",
    label: "Resend",
    hint: "an API key",
    before: "Verify your sending domain in Resend first.",
    fields: [apiKey("Resend API key", "re_…")],
    requires: ["EMAIL_API_KEY"],
  },
  {
    id: "postmark",
    label: "Postmark",
    hint: "a server token",
    before: "Use a server's API token; mail goes out on its outbound stream.",
    fields: [apiKey("Postmark server token")],
    requires: ["EMAIL_API_KEY"],
  },
  {
    id: "sendgrid",
    label: "SendGrid",
    hint: "an API key",
    before: "Verify the sender or domain in SendGrid first.",
    fields: [apiKey("SendGrid API key", "SG.…")],
    requires: ["EMAIL_API_KEY"],
  },
  {
    id: "mailgun",
    label: "Mailgun",
    hint: "an API key",
    fields: [
      apiKey("Mailgun API key"),
      {
        kind: "select",
        key: "MAILGUN_REGION",
        message: "Which Mailgun region is your domain in?",
        options: [
          { value: "", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
      {
        kind: "text",
        key: "MAILGUN_DOMAIN",
        message: "Mailgun sending domain (leave empty to use the From address's domain)",
        placeholder: "mg.example.com",
        optional: true,
        validate: (v) => (!v || HOSTNAME.test(v) ? null : "A domain, like mg.example.com."),
      },
    ],
    requires: ["EMAIL_API_KEY"],
  },
  {
    id: "ses",
    label: "Amazon SES",
    hint: "an IAM user's access key",
    before:
      "Use an IAM user allowed only ses:SendEmail. While your account is in the SES sandbox, it can only email verified addresses.",
    fields: [
      {
        kind: "text",
        key: "AWS_REGION",
        message: "AWS region",
        initial: "us-east-1",
        validate: (v) => (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(v) ? null : "A region, like us-east-1."),
      },
      {
        kind: "text",
        key: "AWS_ACCESS_KEY_ID",
        message: "Access key ID",
        placeholder: "AKIA…",
        validate: (v) =>
          /^[A-Z0-9]{16,128}$/.test(v) ? null : "An access key ID, like AKIAIOSFODNN7EXAMPLE.",
      },
      {
        kind: "secret",
        key: "AWS_SECRET_ACCESS_KEY",
        message: "Secret access key",
        validate: required("the secret access key"),
      },
    ],
    requires: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  },
  {
    id: "smtp",
    label: "SMTP",
    hint: "any mail server: Google Workspace, Microsoft 365, Fastmail…",
    fields: [
      {
        kind: "text",
        key: "host",
        message: "SMTP server",
        placeholder: "smtp.example.com",
        validate: (v) => (HOSTNAME.test(v) ? null : "A server name, like smtp.example.com."),
      },
      {
        kind: "select",
        key: "port",
        message: "How does it connect?",
        options: [
          { value: "587", label: "Port 587", hint: "STARTTLS, the usual one" },
          { value: "465", label: "Port 465", hint: "TLS from the start" },
        ],
      },
      { kind: "text", key: "user", message: "Username", validate: required("the username") },
      { kind: "secret", key: "password", message: "Password", validate: required("the password") },
    ],
    requires: ["SMTP_URL"],
    secrets: (a) => ({
      SMTP_URL: smtpUrl({
        host: a.host ?? "",
        port: Number(a.port ?? 587),
        user: a.user ?? "",
        password: a.password ?? "",
      }),
    }),
  },
  {
    id: "cloudflare",
    label: "Cloudflare Email Service",
    hint: "no key; needs Workers Paid",
    before:
      "Onboard your sending domain under Email Service in the Cloudflare dashboard first; until then it only reaches verified addresses. This one deploys the Worker again, with a send_email binding.",
    fields: [],
    requires: [],
  },
];

export function provider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * An SMTP URL the Worker reads: credentials percent-encoded, so a password
 * with `@` or `/` survives; `smtps:` for port 465, which is TLS from the start.
 */
export function smtpUrl({
  host,
  port,
  user,
  password,
}: {
  host: string;
  port: number;
  user: string;
  password: string;
}): string {
  const scheme = port === 465 ? "smtps" : "smtp";
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  return `${scheme}://${auth}${host}:${port}`;
}

/** What's wrong with an SMTP_URL, as the Worker parses it; null when nothing is. */
export function smtpUrlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "SMTP_URL isn't a URL. It looks like smtp://user:password@smtp.example.com:587.";
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:")
    return "SMTP_URL starts with smtp:// (port 587) or smtps:// (port 465).";
  if (!url.hostname) return "SMTP_URL needs the server's name.";
  return null;
}

/** What's wrong with a From address, as the Worker reads it (message.ts parseAddress). */
export function fromProblem(text: string): string | null {
  const trimmed = text.trim();
  const named = /^(.*?)\s*<([^<>\s]+@[^<>\s]+\.[^<>\s@]+)>$/.exec(trimmed);
  if (named || /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(trimmed)) return null;
  return "An address, like Drawpane <design@example.com> or design@example.com.";
}

/** A From address to suggest: on the instance's own domain, when it has one. */
export function suggestedFrom(domain: string | null): string {
  return `Drawpane <drawpane@${domain ?? "example.com"}>`;
}

/** The secrets a provider reads, besides EMAIL_PROVIDER and EMAIL_FROM: required and optional. */
export function usedSecrets(chosen: Provider): EmailSecret[] {
  const asked = chosen.fields.map((f) => f.key);
  return EMAIL_SECRETS.filter((name) => chosen.requires.includes(name) || asked.includes(name));
}

/** The secrets for a provider and its answers: everything the Worker reads, blanks left out. */
export function emailSecrets(
  chosen: Provider,
  from: string,
  answers: Readonly<Record<string, string>>,
): EmailSecrets {
  const own: EmailSecrets = chosen.secrets
    ? chosen.secrets(answers)
    : Object.fromEntries(
        Object.entries(answers).filter(
          ([key, value]) => value && (EMAIL_SECRETS as readonly string[]).includes(key),
        ),
      );
  return { EMAIL_PROVIDER: chosen.id, EMAIL_FROM: from.trim(), ...own };
}

/**
 * Email settings from the environment, for `--yes` (scripts and CI): the
 * same names the Worker reads. Says what's missing or wrong, all at once.
 */
export function emailSecretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { provider: Provider; secrets: EmailSecrets } | { provider: null } {
  const id = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!id)
    throw new Problem(
      `Set EMAIL_PROVIDER (${PROVIDERS.map((p) => p.id).join(", ")} or off) and the provider's settings, or run this in a terminal to be asked.`,
    );
  if (id === "off") return { provider: null };
  const chosen = provider(id);
  if (!chosen)
    throw new Problem(
      `EMAIL_PROVIDER is "${id}". Use one of: ${PROVIDERS.map((p) => p.id).join(", ")}, or off.`,
    );
  const value = (name: EmailSecret) => env[name]?.trim() || undefined;
  const problems: string[] = [];
  const from = value("EMAIL_FROM");
  const fromIssue = from
    ? fromProblem(from)
    : "Set EMAIL_FROM, like Drawpane <design@example.com>.";
  if (fromIssue) problems.push(`EMAIL_FROM: ${fromIssue}`);
  const missing = chosen.requires.filter((name) => !value(name));
  if (missing.length > 0) problems.push(`${chosen.label} also needs ${missing.join(", ")}.`);
  const url = value("SMTP_URL");
  if (chosen.id === "smtp" && url) {
    const issue = smtpUrlProblem(url);
    if (issue) problems.push(issue);
  }
  if (problems.length > 0) throw new Problem(problems.join("\n"));
  const secrets: EmailSecrets = { EMAIL_PROVIDER: chosen.id };
  for (const name of ["EMAIL_FROM", ...usedSecrets(chosen)] as const) {
    const v = value(name);
    if (v) secrets[name] = v;
  }
  return { provider: chosen, secrets };
}

/** Secrets the Worker has from email setups that the new one doesn't use: removed, so old keys don't linger. */
export function staleEmailSecrets(existing: readonly string[], next: EmailSecrets): EmailSecret[] {
  return EMAIL_SECRETS.filter((name) => existing.includes(name) && !(name in next));
}
