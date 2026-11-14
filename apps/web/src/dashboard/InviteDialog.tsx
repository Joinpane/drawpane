/**
 * Inviting someone: a single-use link with a role, sent to their email when
 * the instance sends email (or copied and shared by hand), and an optional
 * note saying who it's for, so the Members page can tell pending ones apart.
 */
import { Button, Icon, TextField } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api, type Role } from "../api/client";
import { CopyField } from "../app/CopyField";
import { Dialog } from "../app/Dialog";
import { ROLE_NAMES } from "./roles";

interface Created {
  readonly url: string;
  readonly email: string | null;
  readonly emailed: boolean;
}

export function InviteDialog({
  open,
  teamId,
  onClose,
}: {
  open: boolean;
  teamId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Shared with the Members list: whether this instance can send the email.
  const invites = useQuery({
    queryKey: ["invites", teamId],
    queryFn: () => api.invites(teamId),
    enabled: open,
  });
  const canEmail = invites.data?.canEmail ?? false;
  const [role, setRole] = useState<Role>("editor");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const sending = canEmail && email.trim() !== "";
  const create = useMutation({
    mutationFn: () =>
      api.post<Created>(`/teams/${teamId}/invites`, {
        role,
        note,
        ...(sending ? { email } : {}),
      }),
    onSuccess: (result) => {
      setCreated(result);
      void queryClient.invalidateQueries({ queryKey: ["invites", teamId] });
    },
  });
  // A problem with the address shows on the address; anything else under the form.
  const error = create.error;
  const emailError =
    sending && error instanceof ApiError && (error.status === 400 || error.status === 409)
      ? error.message
      : undefined;
  const close = () => {
    setCreated(null);
    setEmail("");
    setNote("");
    create.reset();
    onClose();
  };
  const who = note.trim() || "one person";
  return (
    <Dialog
      open={open}
      title="Invite to this team"
      onClose={close}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="invite-form" disabled={create.isPending}>
              {sending
                ? create.isPending
                  ? "Sending…"
                  : "Send invite"
                : create.isPending
                  ? "Creating…"
                  : "Create link"}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="app-stack">
          {created.emailed ? (
            <p className="invite__result" role="status">
              <Icon name="check" size={16} />
              <span>
                Sent to <strong>{created.email}</strong>. They can also use this link: it works once
                and expires in 7 days.
              </span>
            </p>
          ) : created.email ? (
            <p className="invite__result invite__result--warn" role="alert">
              <Icon name="warning" size={16} />
              <span>
                The email to <strong>{created.email}</strong> couldn't be sent. Copy the link and
                send it yourself; it works once and expires in 7 days.
              </span>
            </p>
          ) : (
            <p className="app-muted">
              Send this link to {who}. It works once and expires in 7 days.
            </p>
          )}
          <CopyField value={created.url} />
          <p className="app-muted">
            Until it's used, it's listed under Members, where you can take it back.
          </p>
        </div>
      ) : (
        <form
          id="invite-form"
          className="app-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <p className="app-muted">
            {canEmail
              ? "Send a single-use invite by email, or leave the address blank to create a link you share yourself."
              : "Create a single-use link. They'll sign up with a passkey and join with this role."}
          </p>
          <div className="app-radio-row" role="radiogroup" aria-label="Role">
            {(["viewer", "editor", "owner"] as const).map((r) => (
              <label key={r} className="app-radio">
                <input
                  type="radio"
                  name="role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                />
                <span>{ROLE_NAMES[r]}</span>
              </label>
            ))}
          </div>
          {canEmail ? (
            <TextField
              label="Email (optional)"
              type="email"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="lee@example.com"
              value={email}
              maxLength={254}
              error={emailError}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) create.reset();
              }}
            />
          ) : null}
          <TextField
            label="Who's it for? (optional)"
            placeholder="Lee, research"
            value={note}
            maxLength={80}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && !emailError ? <p className="auth__error">{error.message}</p> : null}
        </form>
      )}
    </Dialog>
  );
}
