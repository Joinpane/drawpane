/**
 * The team's people: each person's role, how they sign in, and when they
 * last did. Owners change roles, remove people, and see the invite links
 * not used yet, which they can take back. Anyone can leave, except the last
 * owner: a team always has one. The Worker enforces all of it (api/routes.ts).
 */
import { Button, DropdownMenu, Icon, type MenuItem } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Member, type PendingInvite, type Role } from "../api/client";
import { Dialog } from "../app/Dialog";
import { initials, timeAgo, timeUntil } from "../app/format";
import { ROLE_ABILITIES, ROLE_NAMES, ROLES } from "./roles";

const PROVIDER_NAMES = { github: "GitHub", google: "Google" } as const;

/** "Passkey · GitHub", "2 passkeys". */
function signInMethods(member: Member): string {
  const methods = [
    member.passkeys === 1 ? "Passkey" : member.passkeys > 1 ? `${member.passkeys} passkeys` : null,
    ...member.providers.map((p) => PROVIDER_NAMES[p]),
  ].filter(Boolean);
  return methods.length > 0 ? methods.join(" · ") : "No sign-in yet";
}

type Confirm =
  | { readonly kind: "remove"; readonly member: Member }
  | { readonly kind: "leave"; readonly member: Member }
  | { readonly kind: "step-down"; readonly member: Member; readonly role: Role };

export function MembersView({
  teamId,
  teamName,
  role,
  userId,
  onInvite,
}: {
  teamId: string;
  teamName: string;
  /** Your role on the team. */
  role: Role;
  userId: string | undefined;
  onInvite: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const owner = role === "owner";
  const members = useQuery({ queryKey: ["members", teamId], queryFn: () => api.members(teamId) });
  const invites = useQuery({
    queryKey: ["invites", teamId],
    queryFn: () => api.invites(teamId),
    enabled: owner,
  });
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members", teamId] }),
      queryClient.invalidateQueries({ queryKey: ["teams"] }),
    ]);
  const fail = (e: unknown) =>
    setNotice({ tone: "error", text: e instanceof Error ? e.message : "That didn't work." });

  const setRole = useMutation({
    mutationFn: ({ member, to }: { member: Member; to: Role }) =>
      api.patch(`/teams/${teamId}/members/${member.id}`, { role: to }),
    onSuccess: (_, { member, to }) => {
      setNotice({
        tone: "ok",
        text: `${member.id === userId ? "You're" : `${member.name} is`} now ${article(to)} ${ROLE_NAMES[to].toLowerCase()}.`,
      });
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (member: Member) => api.delete(`/teams/${teamId}/members/${member.id}`),
    onSuccess: async (_, member) => {
      if (member.id === userId) {
        await queryClient.invalidateQueries({ queryKey: ["teams"] });
        await navigate({ to: "/" });
        return;
      }
      setNotice({ tone: "ok", text: `${member.name} was removed from ${teamName}.` });
      void refresh();
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (invite: PendingInvite) => api.delete(`/teams/${teamId}/invites/${invite.id}`),
    onSuccess: () => {
      setNotice({ tone: "ok", text: "Invite taken back. That link no longer works." });
      void queryClient.invalidateQueries({ queryKey: ["invites", teamId] });
    },
    onError: fail,
  });

  const people = members.data?.members ?? [];
  const owners = people.filter((m) => m.role === "owner").length;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? people.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(needle))
    : people;
  const pending = owner ? (invites.data?.invites ?? []) : [];

  const changeRole = (member: Member, to: Role) => {
    if (to === member.role) return;
    setNotice(null);
    // Stepping down yourself takes away what you're using: ask first.
    if (member.id === userId && member.role === "owner")
      setConfirm({ kind: "step-down", member, role: to });
    else setRole.mutate({ member, to });
  };

  return (
    <div className="members">
      <header className="dash__header">
        <h1 className="dash__title">Members</h1>
        <label className="dash__search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Search people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search people"
          />
        </label>
        {owner ? (
          <Button variant="primary" size="lg" icon="plus" onClick={onInvite}>
            Invite people
          </Button>
        ) : null}
      </header>

      {notice ? (
        <p
          className={`members__notice members__notice--${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <Icon name={notice.tone === "error" ? "warning" : "check"} size={12} />
          {notice.text}
        </p>
      ) : null}

      <div className="members__layout">
        <section className="members__card" aria-labelledby="members-title">
          <div className="members__head">
            <h2 id="members-title">People{people.length > 0 ? ` · ${people.length}` : ""}</h2>
            {owners > 0 ? (
              <span className="members__total">
                {owners === 1 ? "1 owner" : `${owners} owners`}
              </span>
            ) : null}
          </div>
          {members.isPending ? (
            <ul className="members__list" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="members__row members__row--skeleton" />
              ))}
            </ul>
          ) : members.error ? (
            <p className="members__empty" role="alert">
              {members.error.message}
            </p>
          ) : shown.length === 0 ? (
            <p className="members__empty">No one matches “{query.trim()}”.</p>
          ) : (
            <ul className="members__list" aria-label="People">
              {shown.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  slot={(people.indexOf(member) % 8) + 1}
                  you={member.id === userId}
                  manage={owner}
                  onlyOwner={member.role === "owner" && owners <= 1}
                  busy={setRole.isPending || remove.isPending}
                  onRole={(to) => changeRole(member, to)}
                  onRemove={() => {
                    setNotice(null);
                    setConfirm({ kind: member.id === userId ? "leave" : "remove", member });
                  }}
                />
              ))}
            </ul>
          )}

          {pending.length > 0 ? (
            <>
              <div className="members__head members__head--section">
                <h2 id="invites-title">Pending invites · {pending.length}</h2>
                <span className="members__total">Single-use links, 7 days</span>
              </div>
              <ul className="members__list" aria-labelledby="invites-title">
                {pending.map((invite) => (
                  <li key={invite.id} className="members__row">
                    <span className="members__avatar members__avatar--invite" aria-hidden="true">
                      <Icon name="link" size={12} />
                    </span>
                    <span className="members__who">
                      <span className="members__name">{invite.note ?? "Invite link"}</span>
                      <span className="members__sub">
                        {invite.createdBy ? `From ${invite.createdBy}, ` : "Created "}
                        {timeAgo(invite.createdAt)}
                      </span>
                    </span>
                    <span className="members__meta">
                      <span>Joins as {ROLE_NAMES[invite.role].toLowerCase()}</span>
                      <span>Expires {timeUntil(invite.expiresAt)}</span>
                    </span>
                    <span className="members__action">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={revoke.isPending}
                        onClick={() => {
                          setNotice(null);
                          revoke.mutate(invite);
                        }}
                        aria-label={`Take back the invite ${invite.note ? `for ${invite.note}` : "link"}`}
                      >
                        Take back
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <aside className="members__side">
          <section className="members__card members__roles" aria-labelledby="roles-title">
            <h2 id="roles-title">What roles can do</h2>
            <dl>
              {ROLES.map((r) => (
                <div key={r}>
                  <dt>{ROLE_NAMES[r]}</dt>
                  <dd>{ROLE_ABILITIES[r]}</dd>
                </div>
              ))}
            </dl>
            <p>A team always has at least one owner.</p>
          </section>
        </aside>
      </div>

      <ConfirmChange
        confirm={confirm}
        teamName={teamName}
        busy={setRole.isPending || remove.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(c) => {
          setConfirm(null);
          if (c.kind === "step-down") setRole.mutate({ member: c.member, to: c.role });
          else remove.mutate(c.member);
        }}
      />
    </div>
  );
}

/** "an owner", "an editor", "a viewer". */
const article = (role: Role) => (role === "viewer" ? "a" : "an");

function MemberRow({
  member,
  slot,
  you,
  manage,
  onlyOwner,
  busy,
  onRole,
  onRemove,
}: {
  member: Member;
  slot: number;
  you: boolean;
  /** You're an owner: you can change roles and remove people. */
  manage: boolean;
  /** The team's last owner: can't step down or leave. */
  onlyOwner: boolean;
  busy: boolean;
  onRole: (role: Role) => void;
  onRemove: () => void;
}) {
  return (
    <li className="members__row">
      <span
        className="members__avatar"
        style={{ boxShadow: `inset 0 0 0 2px var(--presence-${slot})` }}
        aria-hidden="true"
      >
        {initials(member.name)}
      </span>
      <span className="members__who">
        <span className="members__name">
          {member.name}
          {you ? <span className="members__you">You</span> : null}
        </span>
        <span className="members__sub">{member.email}</span>
      </span>
      <span className="members__meta">
        <span>{signInMethods(member)}</span>
        <span>
          {member.lastSignedInAt
            ? `Signed in ${timeAgo(member.lastSignedInAt)}`
            : "Hasn't signed in yet"}
        </span>
      </span>
      <span className="members__action">
        <RoleControl
          member={member}
          you={you}
          manage={manage}
          onlyOwner={onlyOwner}
          busy={busy}
          onRole={onRole}
          onRemove={onRemove}
        />
      </span>
    </li>
  );
}

/**
 * An owner's dropdown: the roles, then remove (or leave, on your own row).
 * Everyone else sees the role, and a way to leave on their own row.
 */
function RoleControl({
  member,
  you,
  manage,
  onlyOwner,
  busy,
  onRole,
  onRemove,
}: {
  member: Member;
  you: boolean;
  manage: boolean;
  onlyOwner: boolean;
  busy: boolean;
  onRole: (role: Role) => void;
  onRemove: () => void;
}) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const name = ROLE_NAMES[member.role];
  if (onlyOwner && you) {
    return (
      <span
        className="members__role"
        title="A team always has an owner. Make someone else an owner to change this."
      >
        {name}
      </span>
    );
  }
  if (!manage) {
    return you ? (
      <span className="members__role-with-leave">
        <span className="members__role">{name}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
          Leave
        </Button>
      </span>
    ) : (
      <span className="members__role">{name}</span>
    );
  }
  const items: MenuItem[] = [
    ...ROLES.map((r) => ({
      id: r,
      label: ROLE_NAMES[r],
      checked: r === member.role,
      // The last owner can't be moved off owner; the server says so too.
      disabled: onlyOwner && r !== "owner",
      onSelect: () => onRole(r),
    })),
    { id: "sep", separator: true as const },
    {
      id: "remove",
      label: you ? "Leave team" : "Remove from team",
      danger: true,
      disabled: onlyOwner,
      onSelect: onRemove,
    },
  ];
  return (
    <>
      <Button
        ref={setButton}
        size="sm"
        variant="ghost"
        className="members__role-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${member.name}: ${name}. Change role`}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {name}
        <Icon name="chevron-down" size={12} />
      </Button>
      {open && button ? (
        <DropdownMenu
          anchor={button}
          label={`Role for ${member.name}`}
          items={items}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ConfirmChange({
  confirm,
  teamName,
  busy,
  onClose,
  onConfirm,
}: {
  confirm: Confirm | null;
  teamName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (confirm: Confirm) => void;
}) {
  const copy = confirm ? confirmCopy(confirm, teamName) : null;
  return (
    <Dialog
      open={confirm !== null}
      title={copy?.title ?? ""}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={confirm?.kind === "step-down" ? "primary" : "danger"}
            disabled={busy}
            onClick={() => confirm && onConfirm(confirm)}
          >
            {copy?.action}
          </Button>
        </>
      }
    >
      <p className="app-muted">{copy?.body}</p>
    </Dialog>
  );
}

function confirmCopy(confirm: Confirm, teamName: string) {
  switch (confirm.kind) {
    case "remove":
      return {
        title: `Remove ${confirm.member.name}?`,
        body: `${confirm.member.name} loses access to ${teamName}'s files. Their comments stay. You can invite them again any time.`,
        action: "Remove",
      };
    case "leave":
      return {
        title: `Leave ${teamName}?`,
        body: "You lose access to its files. To come back, ask an owner for a new invite.",
        action: "Leave team",
      };
    case "step-down":
      return {
        title: `Make yourself ${article(confirm.role)} ${ROLE_NAMES[confirm.role].toLowerCase()}?`,
        body: "You won't be able to invite people or change roles any more. Another owner can change it back.",
        action: `Become ${article(confirm.role)} ${ROLE_NAMES[confirm.role].toLowerCase()}`,
      };
  }
}
