/**
 * Signed in, but on no team: after leaving or being removed from your only
 * one. Files belong to teams, so the way back is an invite from an owner.
 */
import { Button } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { forgetCachedData } from "../app/session-cache";
import { AuthLayout } from "./AuthLayout";
import { signOut } from "./passkey";

export function NoTeamPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <AuthLayout
      title="You're not on a team"
      subtitle="Files here belong to teams. Ask a team's owner for an invite link: opening it adds you to their team."
    >
      <div className="auth__no-team">
        <Button variant="primary" size="lg" onClick={() => navigate({ to: "/settings" })}>
          Account settings
        </Button>
        <Button
          variant="ghost"
          size="lg"
          icon="sign-out"
          onClick={async () => {
            await signOut();
            forgetCachedData(queryClient);
            await navigate({ to: "/signin", search: {} });
          }}
        >
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}
