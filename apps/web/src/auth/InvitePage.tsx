import { Button, TextField } from "@drawpane/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api } from "../api/client";
import { AuthLayout, FormError } from "./AuthLayout";
import { registerWithPasskey } from "./passkey";
import { OrDivider, ProviderButtons, providerErrorMessage, useProviders } from "./providers";

const ROLE_LABEL = { owner: "an owner", editor: "an editor", viewer: "a viewer" } as const;

export function InvitePage() {
  const { token } = useParams({ from: "/invite/$token" });
  const { error: providerError, provider } = useSearch({ from: "/invite/$token" });
  const providers = useProviders();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () =>
      api.get<{ teamName: string; role: keyof typeof ROLE_LABEL }>(`/invites/${token}`),
    retry: false,
  });
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    providerErrorMessage(providerError, provider),
  );

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      // Replace cached signed-out data before the router reads it.
      queryClient.clear();
      await navigate({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (invite.isError) {
    return (
      <AuthLayout title="This invite can't be used" subtitle={invite.error.message}>
        <Button size="lg" onClick={() => navigate({ to: "/signin", search: {} })}>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  const title = invite.data ? `Join ${invite.data.teamName}` : "Join a team";
  const subtitle = invite.data
    ? `You're invited as ${ROLE_LABEL[invite.data.role]}.`
    : "Checking your invite…";

  if (session.data?.user) {
    return (
      <AuthLayout title={title} subtitle={subtitle}>
        <Button
          variant="primary"
          size="lg"
          disabled={busy || !invite.data}
          onClick={() => run(() => api.post(`/invites/${token}/accept`))}
        >
          Join as {session.data.user.name}
        </Button>
        <FormError message={error} />
      </AuthLayout>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => registerWithPasskey({ name, email, inviteToken: token }));
  }

  return (
    <AuthLayout title={title} subtitle={subtitle}>
      {providers.length > 0 && invite.data ? (
        <>
          <ProviderButtons verb="Join" invite={token} />
          <OrDivider />
        </>
      ) : null}
      <form className="auth__form" onSubmit={submit} style={{ gap: "var(--space-300)" }}>
        <TextField
          label="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
          autoFocus
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          icon="key"
          disabled={busy || !invite.data || !name || !email}
        >
          {busy ? "Waiting for your passkey…" : "Create account with a passkey"}
        </Button>
        <FormError message={error} />
      </form>
      <p className="auth__note">
        Already have an account?{" "}
        <a href={`/signin?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in first</a>, then
        open this link again.
      </p>
    </AuthLayout>
  );
}
