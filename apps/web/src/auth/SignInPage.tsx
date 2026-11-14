import { Button } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { forgetCachedData } from "../app/session-cache";
import { AuthLayout, FormError } from "./AuthLayout";
import { signInWithPasskey } from "./passkey";
import { OrDivider, ProviderButtons, providerErrorMessage, useProviders } from "./providers";

export function SignInPage() {
  const navigate = useNavigate();
  const { next, error: providerError, provider } = useSearch({ from: "/signin" });
  const providers = useProviders();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    providerErrorMessage(providerError, provider),
  );

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const user = await signInWithPasskey();
      // Nothing cached for the signed-out page may linger (see forgetCachedData).
      forgetCachedData(queryClient);
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
      {providers.length > 0 ? (
        <>
          <OrDivider />
          <ProviderButtons {...(next ? { next } : {})} />
        </>
      ) : null}
      <FormError message={error} />
      <p className="auth__note">
        New here? Ask a teammate for an invite link. There are no passwords here: you sign in with a
        passkey{providers.length > 0 ? ` or ${providers.map((p) => p.name).join(" or ")}` : ""}.
      </p>
    </AuthLayout>
  );
}
