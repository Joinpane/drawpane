import { Button, TextField } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { AuthLayout, FormError } from "./AuthLayout";
import { registerWithPasskey } from "./passkey";

/**
 * The installer opens `/setup#token=…` so the token is filled in. A fragment
 * never reaches the server or its logs, and it's taken off the address bar
 * once read.
 */
function tokenFromLink(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

/** First run: the instance owner creates the first account with the deploy's setup token. */
export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [setupToken, setSetupToken] = useState(tokenFromLink);
  useEffect(() => {
    if (tokenFromLink()) history.replaceState(history.state, "", window.location.pathname);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await registerWithPasskey({ name, email, setupToken: setupToken.trim() });
      // Replace cached signed-out data before the router reads it.
      queryClient.clear();
      queryClient.setQueryData(["session"], { user, needsSetup: false });
      await navigate({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Set up this instance"
      subtitle="Create the first account. You'll own the first team and can invite everyone else."
    >
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
        <TextField
          label="Setup token"
          hint="Printed when this instance was deployed."
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          icon="key"
          disabled={busy || !name || !email || !setupToken}
        >
          {busy ? "Waiting for your passkey…" : "Create account with a passkey"}
        </Button>
        <FormError message={error} />
      </form>
    </AuthLayout>
  );
}
