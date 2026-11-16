import {
  Badge,
  Button,
  Icon,
  IconButton,
  type IconName,
  MenuButton,
  type MenuItem,
  TextField,
} from "@drawpane/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileMeta, type Project, type Role } from "../api/client";
import { Dialog } from "../app/Dialog";
import { initials, modKey, timeAgo } from "../app/format";
import { useMediaQuery } from "../app/media";
import { setTheme, useThemePreference } from "../app/theme";
import { signOut } from "../auth/passkey";
import { InboxView } from "../inbox/InboxView";
import { useUnread } from "../inbox/inbox";
import { KitStoreView } from "../kits/KitStore";
import { FileThumbnail } from "./FileThumbnail";
import { isFigFile } from "./fig-import";
import { ImportDialog } from "./ImportDialog";
import { InviteDialog } from "./InviteDialog";
import { MembersView } from "./Members";
import { isPenpotFile } from "./penpot-import";
import { highlightParts, matchesAll, useDebounced } from "./search";
import { TeamFontsView } from "./TeamFonts";
import type { TeamView } from "./views";
import "./dashboard.css";
import { forgetCachedData } from "../app/session-cache";

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
  // Fonts, Members and Kits are team pages of their own, with no files to list.
  const showsFiles = view !== "fonts" && view !== "members" && view !== "inbox" && view !== "kits";
  const unread = useUnread();
  const files = useQuery({
    queryKey: ["files", teamId, projectId ?? null, view ?? "recent"],
    enabled: showsFiles,
    queryFn: () =>
      projectId
        ? api.projectFiles(projectId)
        : api.teamFiles(teamId, view === "trash" ? "trash" : "recent"),
  });

  const team = teams.data?.teams.find((t) => t.id === teamId);
  // Not (or no longer) on this team, say after being removed: on to another team, or to the page that explains.
  const notOnTeam = teams.isSuccess && !team;
  useEffect(() => {
    if (notOnTeam) void navigate({ to: "/", replace: true });
  }, [notOnTeam, navigate]);
  // The Members page's list, when it's loaded, is fresher than the count that came with the teams.
  const memberList = useQuery({
    queryKey: ["members", teamId],
    queryFn: () => api.members(teamId),
    enabled: false,
  });
  const memberCount = memberList.data?.members.length ?? team?.members ?? null;
  const role: Role = team?.role ?? "viewer";
  const canEdit = role !== "viewer";
  const project = projects.data?.projects.find((p) => p.id === projectId);
  const drafts = projects.data?.projects[0];
  const [query, setQuery] = useState("");
  // On a phone the sidebar is a drawer, opened from the top bar.
  const phone = useMediaQuery(PHONE);
  const [navOpen, setNavOpen] = useState(false);
  // Left the phone width (a rotated tablet, a wider window): the drawer has no meaning there.
  useEffect(() => {
    if (!phone) setNavOpen(false);
  }, [phone]);
  // The drawer open on a phone is modal: everything behind it is out of reach.
  const behind = phone && navOpen;
  // Shut by Escape, the scrim or its close button: focus goes back to the menu button, once
  // it's no longer inert (after the commit that closes the drawer, not before).
  const refocus = useRef(false);
  const closeNav = () => {
    refocus.current = true;
    setNavOpen(false);
  };
  useEffect(() => {
    if (navOpen || !refocus.current) return;
    refocus.current = false;
    menuButton.current?.focus();
  }, [navOpen]);
  const menuButton = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  // Somewhere chosen: the drawer gets out of the way.
  useEffect(() => setNavOpen(false), [teamId, projectId, view]);
  useEffect(() => {
    if (!navOpen) return;
    // Into the drawer, on the current place (or the first).
    const links = side.current?.querySelectorAll<HTMLElement>("a, button");
    const current = side.current?.querySelector<HTMLElement>('[aria-current="page"]');
    (current ?? links?.[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNav();
    };
    // A destination picked (clicked, or Enter on it), even the current one: the drawer closes.
    const onPick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest("a")) setNavOpen(false);
    };
    const drawer = side.current;
    document.addEventListener("keydown", onKey);
    drawer?.addEventListener("click", onPick);
    return () => {
      document.removeEventListener("keydown", onKey);
      drawer?.removeEventListener("click", onPick);
    };
  }, [navOpen]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  // A file dragged over the page: show where it can go.
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // The files' search, or the search of the team page on screen (Kits).
        (
          searchRef.current ?? document.querySelector<HTMLInputElement>(".dash__search input")
        )?.focus();
        return;
      }
      // N: a blank file, straight away (outside fields and dialogs).
      const target = e.target as HTMLElement | null;
      if (
        e.key.toLowerCase() === "n" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !target?.closest("input, textarea, select, [contenteditable], dialog")
      ) {
        e.preventDefault();
        newBlank.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const invalidateFiles = () => {
    void queryClient.invalidateQueries({ queryKey: ["files", teamId] });
    void queryClient.invalidateQueries({ queryKey: ["projects", teamId] });
  };

  // Read by the key handler, which is set up once.
  const newBlank = useRef(() => {});
  const createFile = useMutation({
    mutationFn: (target: Project) =>
      api.post<{ file: FileMeta }>(`/projects/${target.id}/files`, { name: "Untitled" }),
    onSuccess: ({ file }) => {
      invalidateFiles();
      void navigate({ to: "/f/$fileId", params: { fileId: file.id } });
    },
  });

  // Searching looks through every file on the team (or the whole trash), not just this list.
  const searching = query.trim() !== "";
  const term = useDebounced(query.trim(), 150);
  const results = useQuery({
    queryKey: ["files", teamId, "search", view === "trash" ? "trash" : "live", term],
    enabled: showsFiles && term !== "",
    queryFn: () => api.searchFiles(teamId, term, view === "trash"),
    // Refining a search keeps the last results up until the new ones arrive.
    placeholderData: keepPreviousData,
  });
  const visible = useMemo(() => {
    const list = files.data?.files ?? [];
    if (!searching) return list;
    // Until the first answer arrives, what's on screen already, filtered the same way.
    return results.data?.files ?? list.filter((f) => matchesAll(f.name, query));
  }, [files.data, results.data, searching, query]);
  // The server has answered for what's typed now: only then can "nothing matches" be said.
  const settled =
    searching && results.isSuccess && !results.isPlaceholderData && term === query.trim();
  const capped = settled && (results.data?.files.length ?? 0) >= SEARCH_RESULTS;

  const heading = searching
    ? `Results for “${query.trim()}”`
    : view === "trash"
      ? "Trash"
      : project
        ? project.name
        : "Recent files";
  const target = project ?? drafts;
  newBlank.current = () => {
    if (canEdit && target && view !== "trash" && !createFile.isPending) createFile.mutate(target);
  };
  const canImport = canEdit && !!target && showsFiles && view !== "trash";
  /** The New file page: frame sizes and templates. (New file and N make a blank file directly.) */
  const openNewFile = () =>
    void navigate({
      to: "/t/$teamId/new",
      params: { teamId },
      search: target ? { project: target.id } : {},
    });
  const openImport = (file: File | null = null) => {
    setImportFile(file);
    setImportOpen(true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping a .fig or .penpot file anywhere imports it; the Import button is the keyboard way
    <div
      className={`dash${navOpen ? " dash--nav-open" : ""}`}
      onDragOver={(e) => {
        if (!canImport || !e.dataTransfer.types.includes("Files") || importOpen) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        if (!canImport || importOpen) return;
        e.preventDefault();
        setDragging(false);
        const files = [...e.dataTransfer.files];
        const file = files.find((f) => isFigFile(f) || isPenpotFile(f)) ?? files[0];
        if (file) openImport(file);
      }}
    >
      <header className="dash__topbar" inert={behind}>
        <IconButton
          ref={menuButton}
          icon="menu"
          size="md"
          // Only reachable while the drawer is shut (it's inert behind the open drawer).
          label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="dash-nav"
          onClick={() => setNavOpen((v) => !v)}
        />
        <span className="dash__topbar-team">{team?.name ?? ""}</span>
        {unread > 0 ? (
          <Link
            to="/t/$teamId"
            params={{ teamId }}
            search={{ view: "inbox" }}
            className="dash__badge dash__topbar-inbox"
          >
            {unread > 99 ? "99+" : unread}
            <span className="dp-visually-hidden"> unread in your inbox</span>
          </Link>
        ) : null}
      </header>
      {behind ? <div className="dash__scrim" aria-hidden="true" onClick={closeNav} /> : null}
      <aside
        id="dash-nav"
        ref={side}
        className="dash__side"
        aria-label="Navigation"
        // Off screen on a phone until opened: out of the tab order too.
        inert={phone && !navOpen}
        {...(behind ? { role: "dialog", "aria-modal": true } : {})}
      >
        {behind ? (
          <IconButton
            icon="close"
            size="md"
            label="Close navigation"
            className="dash__side-close"
            onClick={closeNav}
          />
        ) : null}
        <TeamSwitcher teamName={team?.name ?? "…"} members={memberCount} />
        <nav className="dash__nav">
          <NavLink active={!projectId && !view} icon="history" to={{ teamId }} label="Recent" />
          <NavLink
            active={view === "inbox"}
            icon="inbox"
            to={{ teamId, view: "inbox" }}
            label="Inbox"
            badge={unread}
          />
          <NavLink
            active={view === "fonts"}
            icon="text"
            to={{ teamId, view: "fonts" }}
            label="Fonts"
          />
          <NavLink
            active={view === "kits"}
            icon="book"
            to={{ teamId, view: "kits" }}
            label="Kit store"
          />
          <NavLink
            active={view === "members"}
            icon="people"
            to={{ teamId, view: "members" }}
            label="Members"
          />
          <NavLink
            active={view === "trash"}
            icon="trash"
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
          <UserMenu
            name={session.data?.user?.name ?? ""}
            email={session.data?.user?.email ?? ""}
            admin={session.data?.user?.isAdmin === true}
          />
        </div>
      </aside>

      {view === "fonts" ? (
        <main className="dash__main" inert={behind}>
          <TeamFontsView teamId={teamId} canEdit={canEdit} />
        </main>
      ) : view === "kits" ? (
        <main className="dash__main" inert={behind}>
          <KitStoreView teamId={teamId} canEdit={canEdit} />
        </main>
      ) : view === "inbox" ? (
        <main className="dash__main" inert={behind}>
          <InboxView />
        </main>
      ) : view === "members" ? (
        <main className="dash__main" inert={behind}>
          <MembersView
            teamId={teamId}
            teamName={team?.name ?? "this team"}
            role={role}
            userId={session.data?.user?.id}
            onInvite={() => setInviteOpen(true)}
          />
        </main>
      ) : (
        <main className="dash__main" inert={behind}>
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
            {canImport ? (
              <Button
                size="lg"
                icon="board"
                onClick={openNewFile}
                aria-label="Templates"
                title="Templates"
              >
                <span className="dash__btn-label">Templates</span>
              </Button>
            ) : null}
            {canImport ? (
              <Button
                size="lg"
                icon="import"
                onClick={() => openImport()}
                aria-label="Import"
                title="Import from Figma or Penpot"
              >
                <span className="dash__btn-label">Import</span>
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
          ) : searching && results.isError ? (
            <div className="dash__empty" role="alert">
              <p className="app-display-md">Couldn't search.</p>
              <p className="app-muted">{results.error.message}</p>
              <Button onClick={() => void results.refetch()}>Try again</Button>
            </div>
          ) : visible.length === 0 && searching && !settled ? (
            <p className="dash__searching" aria-live="polite">
              Searching every file on the team…
            </p>
          ) : visible.length === 0 ? (
            <EmptyState
              trash={view === "trash"}
              searching={searching}
              canCreate={canEdit && !!target}
              onCreate={() => target && createFile.mutate(target)}
              onTemplates={canEdit && target ? openNewFile : null}
              onImport={canImport ? () => openImport() : null}
            />
          ) : (
            <>
              {capped ? (
                <p className="dash__search-note">
                  Showing the best {SEARCH_RESULTS} matches. Add a word to narrow it down.
                </p>
              ) : null}
              <ul className="dash__grid" aria-busy={searching && results.isFetching}>
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
                    highlight={searching ? query : ""}
                    onChanged={invalidateFiles}
                  />
                ))}
              </ul>
            </>
          )}
        </main>
      )}

      <InviteDialog open={inviteOpen} teamId={teamId} onClose={() => setInviteOpen(false)} />
      {target ? (
        <ImportDialog
          open={importOpen}
          projectId={target.id}
          projectName={target.name}
          file={importFile}
          onClose={() => {
            setImportOpen(false);
            setImportFile(null);
          }}
          onImported={invalidateFiles}
        />
      ) : null}
      {dragging ? (
        <div className="dash__drop" aria-hidden="true">
          <p>
            <Icon name="import" size={16} />
            Drop to import into {target?.name ?? "this project"}
          </p>
        </div>
      ) : null}
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

/** How many results a search returns at most (the Worker's SEARCH_LIMIT). */
const SEARCH_RESULTS = 50;

/** Where the sidebar becomes a drawer (dashboard.css). */
const PHONE = "(max-width: 760px)";

function TeamSwitcher({ teamName, members }: { teamName: string; members: number | null }) {
  return (
    <div className="dash__team">
      <span className="dash__team-mark" aria-hidden="true">
        {initials(teamName).slice(0, 1)}
      </span>
      <span className="dash__team-text">
        <span className="dash__team-name">{teamName}</span>
        {members !== null ? (
          <span className="dash__team-meta">
            {members === 1 ? "Just you" : `${members} people`}
          </span>
        ) : null}
      </span>
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
  badge,
}: {
  active: boolean;
  icon?: IconName;
  dot?: number;
  to: { teamId: string; project?: string; view?: TeamView };
  label: string;
  count?: number;
  /** Something new: a count in the signal colour, read out as "N unread". */
  badge?: number;
}) {
  const { teamId, ...search } = to;
  return (
    <Link
      to="/t/$teamId"
      params={{ teamId }}
      search={search}
      // Exact: otherwise Recent (no search) counts as active on every view.
      activeOptions={{ exact: true }}
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
      {badge !== undefined && badge > 0 ? (
        <span className="dash__badge">
          {badge > 99 ? "99+" : badge}
          <span className="dp-visually-hidden"> unread</span>
        </span>
      ) : null}
    </Link>
  );
}

function UserMenu({ name, email, admin }: { name: string; email: string; admin: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const theme = useThemePreference();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return (
    <div className="dash__user">
      <Link to="/settings" className="dash__account" title="Account settings">
        <span className="dash__avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="dash__user-text">
          <strong>{name}</strong>
          <span>{email}</span>
        </span>
      </Link>
      {admin ? (
        <Link
          to="/admin/health"
          className="dp-iconbtn"
          aria-label="Instance health and cost"
          title="Instance health and cost"
        >
          <Icon name="bolt" size={16} />
        </Link>
      ) : null}
      <IconButton
        icon={theme === "dark" ? "moon" : theme === "light" ? "sun" : "fit"}
        label={`Theme: ${theme}. Switch to ${next}`}
        onClick={() => setTheme(next)}
      />
      <IconButton
        icon="sign-out"
        label="Sign out"
        onClick={async () => {
          await signOut();
          forgetCachedData(queryClient);
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
  highlight,
  onChanged,
}: {
  file: FileMeta;
  trash: boolean;
  canEdit: boolean;
  isOwner: boolean;
  projectName: string;
  /** A search query whose words are marked in the name. */
  highlight: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [error, setError] = useState<string | null>(null);
  const menuItems: MenuItem[] = [
    { label: "Rename", icon: "rename", onSelect: () => setRenaming(true) },
    {
      label: "Duplicate",
      icon: "duplicate",
      onSelect: () =>
        void act(() =>
          api.post(`/projects/${file.projectId}/files`, {
            name: `${file.name} (copy)`.slice(0, 120),
            from: file.id,
          }),
        ),
    },
    file.isTemplate
      ? {
          label: "Remove from templates",
          icon: "close",
          onSelect: () => void act(() => api.patch(`/files/${file.id}`, { isTemplate: false })),
        }
      : {
          label: "Make a template",
          icon: "component",
          onSelect: () => void act(() => api.patch(`/files/${file.id}`, { isTemplate: true })),
        },
    { separator: true },
    {
      label: "Move to trash",
      icon: "trash",
      danger: true,
      onSelect: () => void act(() => api.delete(`/files/${file.id}`)),
    },
  ];

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
        <FileThumbnail fileId={file.id} thumbnailAt={file.thumbnailAt} />
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
            {highlightParts(file.name, highlight).map((part, i) =>
              part.match ? (
                <mark key={i} className="dash__match">
                  {part.text}
                </mark>
              ) : (
                part.text
              ),
            )}
          </button>
        )}
        <span className="dash__card-sub">
          {file.isTemplate && !trash ? (
            <span className="dash__template-tag">
              <Icon name="component" size={12} />
              Template
            </span>
          ) : null}
          {file.openBranches && !trash ? (
            <span
              className="dash__branch-tag"
              title={`${file.openBranches} open ${file.openBranches === 1 ? "branch" : "branches"}`}
            >
              <Icon name="branch" size={12} />
              <span className="dp-visually-hidden">Open branches: </span>
              {file.openBranches}
            </span>
          ) : null}
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
            <MenuButton label={`Options for ${file.name}`} items={menuItems} />
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
  onImport,
  onTemplates,
}: {
  trash: boolean;
  searching: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onImport: (() => void) | null;
  onTemplates: (() => void) | null;
}) {
  if (searching) {
    return (
      <div className="dash__empty">
        <p className="app-display-md">No files match.</p>
        <p className="app-muted">
          {trash
            ? "Nothing in the trash has that name."
            : "That's every file on the team. Try fewer words, or part of a name."}
        </p>
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
        <div className="dash__empty-actions">
          <Button variant="primary" size="lg" icon="plus" onClick={onCreate}>
            New file
          </Button>
          {onTemplates ? (
            <Button size="lg" icon="board" onClick={onTemplates}>
              Start from a template
            </Button>
          ) : null}
          {onImport ? (
            <Button size="lg" icon="import" onClick={onImport}>
              Import from Figma or Penpot
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
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
