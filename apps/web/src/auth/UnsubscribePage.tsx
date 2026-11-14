/**
 * Where an email's "Stop these emails" link leads: it asks first (a link
 * scanner opening it changes nothing), then turns email off for whoever the
 * link was made for. No sign-in needed: the link is the proof.
 */
import { Button } from "@drawpane/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { api } from "../api/client";
import { AuthLayout } from "./AuthLayout";

export function UnsubscribePage() {
  const { token } = useSearch({ from: "/unsubscribe" });
  const stop = useMutation({
    mutationFn: () =>
      api.post<{ email: string }>(`/email/unsubscribe?token=${encodeURIComponent(token ?? "")}`),
  });
  if (stop.isSuccess)
    return (
      <AuthLayout
        title="You won't get these emails"
        subtitle={`Nothing more goes to ${stop.data.email}. Your inbox in Drawpane still has everything.`}
      >
        <p className="auth__muted">
          Changed your mind? Choose how you hear in{" "}
          <Link to="/settings" className="auth__link">
            account settings
          </Link>
          .
        </p>
      </AuthLayout>
    );
  return (
    <AuthLayout
      title="Stop emails from Drawpane?"
      subtitle="No more emails about mentions, replies or resolved comments. Your inbox in Drawpane keeps them all."
    >
      <div className="auth__no-team">
        <Button
          variant="primary"
          size="lg"
          disabled={!token || stop.isPending}
          onClick={() => stop.mutate()}
        >
          {stop.isPending ? "Stopping…" : "Stop emails"}
        </Button>
      </div>
      {stop.isError || !token ? (
        <p className="auth__error" role="alert">
          {stop.error?.message ??
            "This link is missing its code. Use the link from the email, or change email settings in your account."}
        </p>
      ) : null}
    </AuthLayout>
  );
}
