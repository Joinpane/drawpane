/**
 * Access tokens (docs/decisions/0011-mcp-server.md): connect an MCP client
 * (an AI agent, an IDE) to this instance's MCP server. A token reads every
 * file you can, and changes none; it's shown once, when it's made.
 */
import { Button, Icon, IconButton, Logo, TextField } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api } from "../api/client";
import { timeAgo } from "../app/format";
import { SettingsNav } from "./SettingsNav";
import "./account.css";

interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const EXPIRIES = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "A year" },
  { value: "never", label: "Never" },
] as const;

/** This instance's MCP endpoint, as a client reaches it. */
const endpoint = () => `${window.location.origin}/api/mcp`;

/** The command that adds this server to Claude Code, with `token` (or a placeholder). */
const claudeCommand = (token: string) =>
  `claude mcp add --transport http drawpane ${endpoint()} --header "Authorization: Bearer ${token}"`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    />
  );
}

export function TokensPage() {
  const queries = useQueryClient();
  const list = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.get<{ tokens: ApiToken[] }>("/account/tokens"),
  });
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRIES)[number]["value"]>("90");
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const refresh = () => queries.invalidateQueries({ queryKey: ["api-tokens"] });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string; info: ApiToken }>("/account/tokens", {
        name: name.trim(),
        expiresInDays: expiry === "never" ? null : Number(expiry),
      }),
    onSuccess: ({ token, info }) => {
      setMade({ token, name: info.name });
      setMaking(false);
      setName("");
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/account/tokens/${id}`),
    onSuccess: () => {
      setRevoking(null);
      void refresh();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate();
  };
  const tokens = list.data?.tokens ?? [];

  return (
    <div className="account">
      <header className="account__bar">
        <Link to="/" className="account__back">
          <Icon name="arrow-left" size={16} />
          Files
        </Link>
        <Logo size={20} />
      </header>
      <main className="account__main">
        <SettingsNav />
        <h1 className="account__title">Access tokens</h1>
        <p className="account__lede">
          Connect an AI agent or another MCP client to Drawpane. With a token it reads every file
          you can (outlines, components, tokens, comments, history) and changes none.
        </p>

        <section className="account__section" aria-labelledby="connect-title">
          <h2 id="connect-title" className="account__heading">
            Connect a client
          </h2>
          <div className="tokens__field">
            <span className="tokens__label">MCP server</span>
            <code className="tokens__code">{endpoint()}</code>
            <CopyButton text={endpoint()} label="Copy the server address" />
          </div>
          <p className="account__hint">
            It speaks MCP over Streamable HTTP, with the token in an{" "}
            <code>Authorization: Bearer</code> header. For Claude Code, make a token below and run
            the command it shows.
          </p>
        </section>

        <section className="account__section" aria-labelledby="tokens-title">
          <div className="account__heading-row">
            <h2 id="tokens-title" className="account__heading">
              Your tokens
            </h2>
            {making ? null : (
              <Button size="sm" icon="plus" onClick={() => setMaking(true)}>
                New token
              </Button>
            )}
          </div>

          {made ? (
            <div className="tokens__made" role="status">
              <p className="tokens__made-title">
                <Icon name="check" size={16} />
                Copy “{made.name}” now. You won’t see it again.
              </p>
              <div className="tokens__field">
                <code className="tokens__code tokens__code--secret">{made.token}</code>
                <CopyButton text={made.token} label="Copy the token" />
              </div>
              <span className="tokens__label">Add it to Claude Code</span>
              <div className="tokens__field">
                <code className="tokens__code tokens__code--wrap">{claudeCommand(made.token)}</code>
                <CopyButton text={claudeCommand(made.token)} label="Copy the command" />
              </div>
              <Button size="sm" variant="secondary" onClick={() => setMade(null)}>
                Done
              </Button>
            </div>
          ) : null}

          {making ? (
            <form className="tokens__form" onSubmit={submit}>
              <TextField
                label="Name"
                placeholder="Claude Code on my laptop"
                value={name}
                maxLength={80}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                {...(create.error ? { error: create.error.message } : {})}
              />
              <label className="dp-tf tokens__expiry">
                <span className="dp-tf__label">Expires</span>
                <select
                  className="dp-tf__input"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value as typeof expiry)}
                >
                  {EXPIRIES.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="tokens__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    setMaking(false);
                    create.reset();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  type="submit"
                  disabled={!name.trim() || create.isPending}
                >
                  {create.isPending ? "Making…" : "Make token"}
                </Button>
              </div>
            </form>
          ) : null}

          {list.isPending ? (
            <div className="account__skeleton" />
          ) : (
            <ul className="account__methods" aria-label="Your tokens">
              {tokens.map((t) => (
                <li key={t.id} className="account__method">
                  <span className="account__method-mark">
                    <Icon name="key" size={16} />
                  </span>
                  <span className="account__method-text">
                    <strong>{t.name}</strong>
                    <span>
                      <code className="tokens__prefix">{t.prefix}…</code> · made{" "}
                      {DATE.format(t.createdAt)} ·{" "}
                      {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"} ·{" "}
                      {t.expiresAt === null
                        ? "never expires"
                        : t.expiresAt < Date.now()
                          ? "expired"
                          : `expires ${DATE.format(t.expiresAt)}`}
                    </span>
                  </span>
                  {revoking === t.id ? (
                    <span className="tokens__confirm">
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={revoke.isPending}
                        aria-label={`Revoke ${t.name} now`}
                        onClick={() => revoke.mutate(t.id)}
                      >
                        Revoke
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Revoke ${t.name}`}
                      onClick={() => setRevoking(t.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
              {tokens.length === 0 ? (
                <li className="account__method account__method--empty">
                  No tokens yet. Make one for each client, so you can revoke them one by one.
                </li>
              ) : null}
            </ul>
          )}
          <p className="account__hint">
            A token acts as you in every team you’re in. Revoking one stops whatever uses it at
            once.
          </p>
        </section>
      </main>
    </div>
  );
}
