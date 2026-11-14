/**
 * Inviting someone: a single-use link with a role, and an optional note
 * saying who it's for, so the Members page can tell pending links apart.
 */
import { Button, TextField } from "@drawpane/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Role } from "../api/client";
import { CopyField } from "../app/CopyField";
import { Dialog } from "../app/Dialog";
import { ROLE_NAMES } from "./roles";

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
  const [role, setRole] = useState<Role>("editor");
  const [note, setNote] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/teams/${teamId}/invites`, { role, note }),
    onSuccess: ({ url }) => {
      setLink(url);
      void queryClient.invalidateQueries({ queryKey: ["invites", teamId] });
    },
  });
  const close = () => {
    setLink(null);
    setNote("");
    create.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      title="Invite to this team"
      onClose={close}
      footer={
        link ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="invite-form" disabled={create.isPending}>
              Create link
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="app-stack">
          <p className="app-muted">
            Send this link to {note.trim() || "one person"}. It works once and expires in 7 days;
            until then it's listed under Members, where you can take it back.
          </p>
          <CopyField value={link} />
        </div>
      ) : (
        <form
          id="invite-form"
          className="app-stack"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <p className="app-muted">
            Create a single-use link. They'll sign up with a passkey and join with this role.
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
          <TextField
            label="Who's it for? (optional)"
            placeholder="Lee, research"
            value={note}
            maxLength={80}
            onChange={(e) => setNote(e.target.value)}
          />
          {create.error ? <p className="auth__error">{create.error.message}</p> : null}
        </form>
      )}
    </Dialog>
  );
}
