/**
 * Account settings: your name, and the ways you sign in. Passkeys can be
 * added and removed; GitHub and Google (when this instance offers them)
 * connected and disconnected. The last way in can't be removed.
 */
import { Button, Icon, IconButton, Logo, TextField } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { api, type User } from "../api/client";
import { initials, timeAgo } from "../app/format";
import { addPasskey } from "./passkey";
import {
  type ProviderId,
  type ProviderInfo,
  ProviderMark,
  providerErrorMessage,
  providerStartUrl,
} from "./providers";
import "./account.css";
import { SettingsNav } from "./SettingsNav";

interface Account {
  user: User;
  passkeys: Array<{
    id: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: number;
    lastUsedAt: number | null;
  }>;
  identities: Array<{ provider: ProviderId; label: string; createdAt: number; lastUsedAt: number }>;
  providers: ProviderInfo[];
}

const DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function AccountPage() {
  const queryClient = useQueryClient();
  const search = useSearch({ from: "/settings" });
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.get<Account>("/account") });
  const [notice, setNotice] = useState<{ tone: "error" | "ok"; text: string } | null>(() => {
    const text = providerErrorMessage(search.error, search.provider);
    return text ? { tone: "error", text } : null;
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["account"] });
  const fail = (e: unknown) =>
    setNotice({
      tone: "error",
      text: e instanceof Error ? e.message : "That didn't work. Try again.",
    });

  const add = useMutation({
    mutationFn: addPasskey,
    onSuccess: () => {
      setNotice({ tone: "ok", text: "Passkey added. You can sign in with it from now on." });
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (path: string) => api.delete(path),
    onSuccess: () => {
      setNotice(null);
      void refresh();
    },
    onError: fail,
  });

  const data = account.data;
  const methods = data ? data.passkeys.length + data.identities.length : 0;
  const last = methods <= 1;

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
        <h1 className="account__title">Account</h1>
        {notice ? (
          <p
            className={`account__notice account__notice--${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            <Icon name={notice.tone === "error" ? "warning" : "check"} size={16} />
            <span>{notice.text}</span>
            <IconButton icon="close" label="Dismiss" onClick={() => setNotice(null)} />
          </p>
        ) : null}

        <section className="account__section" aria-labelledby="profile-title">
          <h2 id="profile-title" className="account__heading">
            Profile
          </h2>
          {data ? <Profile user={data.user} /> : <div className="account__skeleton" />}
        </section>

        <section className="account__section" aria-labelledby="signin-title">
          <div className="account__heading-row">
            <h2 id="signin-title" className="account__heading">
              Ways to sign in
            </h2>
            <Button
              size="sm"
              icon="key"
              disabled={add.isPending || !data}
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Waiting for your passkey…" : "Add a passkey"}
            </Button>
          </div>
          {data ? (
            <ul className="account__methods">
              {data.passkeys.map((p, i) => (
                <li key={p.id} className="account__method">
                  <span className="account__method-mark">
                    <Icon name="key" size={16} />
                  </span>
                  <span className="account__method-text">
                    <strong>Passkey {data.passkeys.length > 1 ? i + 1 : ""}</strong>
                    <span>
                      {p.backedUp ? "Synced" : "On one device"} · added {DATE.format(p.createdAt)}
                      {p.lastUsedAt ? ` · used ${timeAgo(p.lastUsedAt)}` : ""}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={last || remove.isPending}
                    title={last ? "Your only way to sign in" : undefined}
                    onClick={() => remove.mutate(`/account/passkeys/${encodeURIComponent(p.id)}`)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
              {data.providers.map((provider) => {
                const linked = data.identities.find((i) => i.provider === provider.id);
                return (
                  <li key={provider.id} className="account__method">
                    <span className="account__method-mark">
                      <ProviderMark id={provider.id} />
                    </span>
                    <span className="account__method-text">
                      <strong>{provider.name}</strong>
                      <span>
                        {linked
                          ? `${linked.label} · connected ${DATE.format(linked.createdAt)}`
                          : "Not connected"}
                      </span>
                    </span>
                    {linked ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={last || remove.isPending}
                        title={last ? "Your only way to sign in" : undefined}
                        onClick={() => remove.mutate(`/account/identities/${provider.id}`)}
                      >
                        Disconnect
                      </Button>
                    ) : (
                      <a
                        className="account__connect"
                        href={providerStartUrl(provider.id, { intent: "link", next: "/settings" })}
                      >
                        Connect
                      </a>
                    )}
                  </li>
                );
              })}
              {data.passkeys.length === 0 && data.identities.length === 0 ? (
                <li className="account__method account__method--empty">No ways to sign in yet.</li>
              ) : null}
            </ul>
          ) : (
            <div className="account__skeleton" />
          )}
          <p className="account__hint">
            Keep at least one way to sign in. A synced passkey follows you to your other devices;
            {data && data.providers.length > 0
              ? ` a connected ${data.providers.map((p) => p.name).join(" or ")} account signs you in here too.`
              : " add another on each device you use."}
          </p>
        </section>
      </main>
    </div>
  );
}

function Profile({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  useEffect(() => setName(user.name), [user.name]);
  const save = useMutation({
    mutationFn: (value: string) => api.patch<{ user: User }>("/account", { name: value }),
    onSuccess: ({ user: updated }) => {
      queryClient.setQueryData(["session"], (old: { user: User | null } | undefined) =>
        old ? { ...old, user: updated } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const dirty = name.trim() !== user.name && name.trim() !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) save.mutate(name.trim());
  };
  return (
    <form className="account__profile" onSubmit={submit}>
      <span className="account__avatar" aria-hidden="true">
        {initials(name || user.name)}
      </span>
      <div className="account__fields">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />
        <p className="account__email">
          <span>Email</span>
          {user.email}
        </p>
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={!dirty || save.isPending}>
        {save.isSuccess && !dirty ? "Saved" : "Save"}
      </Button>
      {save.error ? (
        <p className="account__field-error" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </form>
  );
}
