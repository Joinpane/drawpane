import { Button } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { AuthLayout, FormError } from "./AuthLayout";
import { signInWithPasskey } from "./passkey";

export function SignInPage() {
  const navigate = useNavigate();
  const { next } = useSearch({ from: "/signin" });
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const user = await signInWithPasskey();
      // Replace cached signed-out data before the router reads it.
      queryClient.clear();
      queryClient.setQueryData(["session"], { user, needsSetup: false });
      await navigate({ to: next ?? "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in to Drawpane" subtitle={<code>{window.location.host}</code>}>
      <Button variant="primary" size="lg" icon="lock" onClick={signIn} disabled={busy} autoFocus>
        {busy ? "Waiting for your passkey…" : "Continue with a passkey"}
      </Button>
      <FormError message={error} />
      <p className="auth__note">
        New here? Ask a teammate for an invite link. Drawpane accounts use passkeys, so there's no
        password to forget.
      </p>
    </AuthLayout>
  );
}
