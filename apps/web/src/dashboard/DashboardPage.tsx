import { Badge, Button, Icon, IconButton, type IconName, TextField } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileMeta, type Project, type Role } from "../api/client";
import { Dialog } from "../app/Dialog";
import { initials, modKey, timeAgo } from "../app/format";
import { setTheme, useThemePreference } from "../app/theme";
import { signOut } from "../auth/passkey";
import { FileThumbnail } from "./FileThumbnail";
import "./dashboard.css";

export function DashboardPage() {
  const { teamId } = useParams({ from: "/t/$teamId" });
  const { project: projectId, view } = useSearch({ from: "/t/$teamId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams });
  const projects = useQuery({
    queryKey: ["projects", teamId],
    queryFn: () => api.projects(teamId),
  });
  const files = useQuery({
    queryKey: ["files", teamId, projectId ?? null, view ?? "recent"],
    queryFn: () =>
      projectId
        ? api.projectFiles(projectId)
        : api.teamFiles(teamId, view === "trash" ? "trash" : "recent"),
  });

  const team = teams.data?.teams.find((t) => t.id === teamId);
  const role: Role = team?.role ?? "viewer";
  const canEdit = role !== "viewer";
  const project = projects.data?.projects.find((p) => p.id === projectId);
  const drafts = projects.data?.projects[0];
  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const invalidateFiles = () => {
    void queryClient.invalidateQueries({ queryKey: ["files", teamId] });
    void queryClient.invalidateQueries({ queryKey: ["projects", teamId] });
  };

  const createFile = useMutation({
    mutationFn: (target: Project) =>
      api.post<{ file: FileMeta }>(`/projects/${target.id}/files`, { name: "Untitled" }),
    onSuccess: ({ file }) => {
      invalidateFiles();
      void navigate({ to: "/f/$fileId", params: { fileId: file.id } });
    },
  });

  const visible = useMemo(() => {
    const list = files.data?.files ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((f) => f.name.toLowerCase().includes(q)) : list;
  }, [files.data, query]);

  const heading = view === "trash" ? "Trash" : project ? project.name : "Recent files";
  const target = project ?? drafts;

  return (
    <div className="dash">
      <aside className="dash__side" aria-label="Navigation">
        <TeamSwitcher teamName={team?.name ?? "…"} members={null} />
        <nav className="dash__nav">
          <NavLink
            active={!projectId && view !== "trash"}
            icon="history"
            to={{ teamId }}
            label="Recent"
          />
          <NavLink
            active={view === "trash"}
            icon="close"
            to={{ teamId, view: "trash" }}
            label="Trash"
          />
        </nav>
        <div className="dash__section">
          <span>Projects</span>
          {canEdit ? (
            <IconButton icon="plus" label="New project" onClick={() => setNewProjectOpen(true)} />
          ) : null}
        </div>
        <nav className="dash__nav dash__projects">
          {projects.data?.projects.map((p, i) => (
            <NavLink
              key={p.id}
              active={projectId === p.id}
              dot={i}
              to={{ teamId, project: p.id }}
              label={p.name}
              count={p.fileCount}
            />
          ))}
        </nav>
        <div className="dash__side-foot">
          <UserMenu name={session.data?.user?.name ?? ""} email={session.data?.user?.email ?? ""} />
        </div>
      </aside>

      <main className="dash__main">
        <header className="dash__header">
          <h1 className="dash__title">{heading}</h1>
          <label className="dash__search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search files"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search files"
            />
            <kbd>{modKey("K")}</kbd>
          </label>
          {role === "owner" ? (
            <Button size="lg" onClick={() => setInviteOpen(true)}>
              Invite
            </Button>
          ) : null}
          {canEdit && view !== "trash" ? (
            <Button
              variant="primary"
              size="lg"
              icon="plus"
              disabled={!target || createFile.isPending}
              onClick={() => target && createFile.mutate(target)}
            >
              New file
            </Button>
          ) : null}
        </header>

        {createFile.error ? (
          <p className="dash__error" role="alert">
            {createFile.error.message}
          </p>
        ) : null}

        {files.isPending ? (
          <div className="dash__grid" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="dash__card dash__card--skeleton" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            trash={view === "trash"}
            searching={query.trim() !== ""}
            canCreate={canEdit && !!target}
            onCreate={() => target && createFile.mutate(target)}
          />
        ) : (
          <ul className="dash__grid">
            {visible.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                trash={view === "trash"}
                canEdit={canEdit}
                isOwner={role === "owner"}
                projectName={
                  projects.data?.projects.find((p) => p.id === file.projectId)?.name ?? ""
                }
                onChanged={invalidateFiles}
              />
            ))}
          </ul>
        )}
      </main>

      <InviteDialog open={inviteOpen} teamId={teamId} onClose={() => setInviteOpen(false)} />
      <NewProjectDialog
        open={newProjectOpen}
        teamId={teamId}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(id) => {
          invalidateFiles();
          void navigate({ to: "/t/$teamId", params: { teamId }, search: { project: id } });
        }}
      />
    </div>
  );
}

function TeamSwitcher({ teamName }: { teamName: string; members: number | null }) {
  return (
    <div className="dash__team">
      <span className="dash__team-mark" aria-hidden="true">
        {initials(teamName).slice(0, 1)}
      </span>
      <span className="dash__team-name">{teamName}</span>
    </div>
  );
}

const DOT_TOKENS = [
  "presence-1",
  "presence-3",
  "signal",
  "presence-5",
  "presence-2",
  "presence-6",
  "presence-4",
  "presence-7",
];

function NavLink({
  active,
  icon,
  dot,
  to,
  label,
  count,
}: {
  active: boolean;
  icon?: IconName;
  dot?: number;
  to: { teamId: string; project?: string; view?: "trash" };
  label: string;
  count?: number;
}) {
  const { teamId, ...search } = to;
  return (
    <Link
      to="/t/$teamId"
      params={{ teamId }}
      search={search}
      className="dash__link"
      aria-current={active ? "page" : undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {dot !== undefined ? (
        <span
          className="dash__dot"
          style={{ background: `var(--${DOT_TOKENS[dot % DOT_TOKENS.length]})` }}
          aria-hidden="true"
        />
      ) : null}
      <span className="dash__link-label">{label}</span>
      {count !== undefined && count > 0 ? <span className="dash__count">{count}</span> : null}
    </Link>
  );
}

function UserMenu({ name, email }: { name: string; email: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const theme = useThemePreference();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return (
    <div className="dash__user">
      <span className="dash__avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="dash__user-text">
        <strong>{name}</strong>
        <span>{email}</span>
      </span>
      <IconButton
        icon={theme === "dark" ? "eye-off" : "eye"}
        label={`Theme: ${theme}. Switch to ${next}`}
        onClick={() => setTheme(next)}
      />
      <IconButton
        icon="export"
        label="Sign out"
        onClick={async () => {
          await signOut();
          queryClient.clear();
          await navigate({ to: "/signin", search: {} });
        }}
      />
    </div>
  );
}

function FileCard({
  file,
  trash,
  canEdit,
  isOwner,
  projectName,
  onChanged,
}: {
  file: FileMeta;
  trash: boolean;
  canEdit: boolean;
  isOwner: boolean;
  projectName: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function commitRename(event?: FormEvent) {
    event?.preventDefault();
    setRenaming(false);
    const next = name.trim();
    if (next && next !== file.name) void act(() => api.patch(`/files/${file.id}`, { name: next }));
    else setName(file.name);
  }

  const open = () => {
    if (!trash) void navigate({ to: "/f/$fileId", params: { fileId: file.id } });
  };

  return (
    <li className="dash__card">
      <button
        type="button"
        className="dash__thumb"
        onClick={open}
        disabled={trash}
        aria-label={`Open ${file.name}`}
      >
        <FileThumbnail fileId={file.id} />
      </button>
      <div className="dash__card-meta">
        {renaming ? (
          <form onSubmit={commitRename}>
            <input
              className="dash__rename"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setName(file.name);
                  setRenaming(false);
                }
              }}
              aria-label="File name"
              // biome-ignore lint/a11y/noAutofocus: the user just asked to rename
              autoFocus
            />
          </form>
        ) : (
          <button
            type="button"
            className="dash__card-name"
            onClick={open}
            onDoubleClick={() => canEdit && !trash && setRenaming(true)}
          >
            {file.name}
          </button>
        )}
        <span className="dash__card-sub">
          {trash
            ? `Deleted ${timeAgo(file.deletedAt ?? file.updatedAt)}`
            : `Edited ${timeAgo(file.updatedAt)}`}
          {projectName ? ` · ${projectName}` : ""}
        </span>
      </div>
      {canEdit ? (
        <div className="dash__card-actions">
          {trash ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => act(() => api.post(`/files/${file.id}/restore`))}
              >
                Restore
              </Button>
              {isOwner ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => act(() => api.delete(`/files/${file.id}?permanent=1`))}
                >
                  Delete forever
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <IconButton icon="text" label="Rename" onClick={() => setRenaming(true)} />
              <IconButton
                icon="close"
                label="Move to trash"
                onClick={() => act(() => api.delete(`/files/${file.id}`))}
              />
            </>
          )}
        </div>
      ) : null}
      {error ? (
        <Badge tone="danger" icon="warning">
          {error}
        </Badge>
      ) : null}
    </li>
  );
}

function EmptyState({
  trash,
  searching,
  canCreate,
  onCreate,
}: {
  trash: boolean;
  searching: boolean;
  canCreate: boolean;
  onCreate: () => void;
}) {
  if (searching) {
    return (
      <div className="dash__empty">
        <p className="app-display-md">No matches.</p>
        <p className="app-muted">Try a different name.</p>
      </div>
    );
  }
  if (trash) {
    return (
      <div className="dash__empty">
        <p className="app-display-md">Trash is empty.</p>
        <p className="app-muted">
          Files you delete stay here until an owner removes them for good.
        </p>
      </div>
    );
  }
  return (
    <div className="dash__empty">
      <p className="app-display-md">A clean slate.</p>
      <p className="app-muted">
        Create a file to start designing. Everyone on the team sees it right away.
      </p>
      {canCreate ? (
        <Button variant="primary" size="lg" icon="plus" onClick={onCreate}>
          New file
        </Button>
      ) : null}
    </div>
  );
}

function InviteDialog({
  open,
  teamId,
  onClose,
}: {
  open: boolean;
  teamId: string;
  onClose: () => void;
}) {
  const [role, setRole] = useState<Role>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/teams/${teamId}/invites`, { role }),
    onSuccess: ({ url }) => setLink(url),
  });
  const close = () => {
    setLink(null);
    setCopied(false);
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
            <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
              Create link
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="app-stack">
          <p className="app-muted">
            Send this link to one person. It works once and expires in 7 days.
          </p>
          <div className="app-copy">
            <code>{link}</code>
            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="app-stack">
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
                <span>{r === "viewer" ? "Can view" : r === "editor" ? "Can edit" : "Owner"}</span>
              </label>
            ))}
          </div>
          {create.error ? <p className="auth__error">{create.error.message}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

function NewProjectDialog({
  open,
  teamId,
  onClose,
  onCreated,
}: {
  open: boolean;
  teamId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>(`/teams/${teamId}/projects`, { name }),
    onSuccess: ({ project }) => {
      setName("");
      onClose();
      onCreated(project.id);
    },
  });
  return (
    <Dialog
      open={open}
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Create project
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          {...(create.error ? { error: create.error.message } : {})}
        />
      </form>
    </Dialog>
  );
}
