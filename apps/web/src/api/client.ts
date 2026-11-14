/** Typed client for the Worker's REST API. Errors carry the server's sentence. */
import type { LibraryPublish, NodeRecord, VersionInfo } from "@drawpane/model";

export type Role = "owner" | "editor" | "viewer";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** Runs the instance: sees its health and cost (Admin pages). */
  readonly isAdmin?: boolean;
}
export interface Team {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  /** How many people are on it. */
  readonly members: number;
}
export interface Project {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly fileCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface FileMeta {
  readonly id: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
  /** When the dashboard thumbnail was last published; null until the editor makes one. */
  readonly thumbnailAt: number | null;
  /** The team starts new files from it (New file → your team). */
  readonly isTemplate?: boolean;
}
export interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: number;
  /** How they sign in: passkeys, and the providers they've connected. Owners only. */
  readonly passkeys?: number;
  readonly providers?: readonly ("github" | "google")[];
  /** When they last started a session, or used a passkey or provider. Owners only. */
  readonly lastSignedInAt?: number | null;
}

/** Something to hear about, from the inbox. */
export interface InboxItem {
  readonly id: string;
  /** Someone mentioned you; replied in a thread you're in; resolved your thread. */
  readonly kind: "mention" | "reply" | "resolved";
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly file: { readonly id: string; readonly name: string };
  /** The file's team: rows name it for people on more than one. */
  readonly team: { readonly id: string; readonly name: string };
  readonly threadId: string;
  /** Whether the thread is resolved now. */
  readonly resolved: boolean;
  /** Who did it; null when their account is gone. */
  readonly actor: { readonly id: string; readonly name: string } | null;
  /** The start of the comment, on one line. */
  readonly excerpt: string;
}

export interface InboxPage {
  readonly items: readonly InboxItem[];
  /** Where the next page starts, or null at the end. */
  readonly before: string | null;
  readonly unread: number;
}

/** Which notifications to mark read: some, a thread's, or all. */
export type MarkRead =
  | { readonly ids: readonly string[] }
  | { readonly threadId: string }
  /** `upTo`: only those up to then, the newest the person was shown. */
  | { readonly all: true; readonly upTo?: number };

/** An invite link not used yet. Its id is the token's hash: never a working link. */
export interface PendingInvite {
  readonly id: string;
  readonly role: Role;
  /** Who it's for, as the owner wrote it. */
  readonly note: string | null;
  /** The address it was sent to, if it was sent by email. */
  readonly email: string | null;
  /** When the email went; null if it wasn't emailed, or sending failed. */
  readonly emailedAt: number | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly createdBy: string | null;
}

export interface ShareLink {
  readonly url: string;
  readonly createdAt: number;
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(
      0,
      "network",
      "Couldn't reach Drawpane. Check your connection and try again.",
    );
  }
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error: { code: string; message: string } }
    | null;
  if (!response.ok) {
    const error = data && "error" in data && data.error ? data.error : null;
    throw new ApiError(
      response.status,
      error?.code ?? "internal",
      error?.message ?? "Something went wrong. Try again.",
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),

  session: () => request<{ user: User | null; needsSetup: boolean }>("GET", "/session"),
  teams: () => request<{ teams: Team[] }>("GET", "/teams"),
  projects: (teamId: string) =>
    request<{ projects: Project[] }>("GET", `/teams/${teamId}/projects`),
  teamFiles: (teamId: string, view: "recent" | "trash" = "recent") =>
    request<{ files: FileMeta[] }>(
      "GET",
      `/teams/${teamId}/files${view === "trash" ? "?view=trash" : ""}`,
    ),
  /** The team's files whose names match every word of `q`, best first (live files, or the trash). */
  searchFiles: (teamId: string, q: string, trash: boolean) =>
    request<{ files: FileMeta[] }>(
      "GET",
      `/teams/${teamId}/files?q=${encodeURIComponent(q)}${trash ? "&view=trash" : ""}`,
    ),
  projectFiles: (projectId: string) =>
    request<{ files: FileMeta[] }>("GET", `/projects/${projectId}/files`),
  file: (fileId: string) =>
    request<{ file: FileMeta; role: Role; project: { id: string; name: string } | null }>(
      "GET",
      `/files/${fileId}`,
    ),
  members: (teamId: string) => request<{ members: Member[] }>("GET", `/teams/${teamId}/members`),
  inbox: (filter: "unread" | "all", before: string | null) =>
    request<InboxPage>(
      "GET",
      `/notifications?filter=${filter}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  unread: () => request<{ unread: number }>("GET", "/notifications/unread"),
  markRead: (which: MarkRead) => request<{ unread: number }>("POST", "/notifications/read", which),
  invites: (teamId: string) =>
    request<{ invites: PendingInvite[]; canEmail: boolean }>("GET", `/teams/${teamId}/invites`),

  /** The file's prototype link, if it's on. */
  shareLink: (fileId: string) =>
    request<{ link: ShareLink | null }>("GET", `/files/${fileId}/share`),
  /** Turns the prototype link on (or returns the live one). */
  createShareLink: (fileId: string) =>
    request<{ link: ShareLink }>("POST", `/files/${fileId}/share`, {}),
  /** Turns the prototype link off; every copy stops working. */
  deleteShareLink: (fileId: string) => request<{ ok: true }>("DELETE", `/files/${fileId}/share`),
  /** What a prototype link opens. Works signed out. */
  resolveShare: (token: string) =>
    request<{ file: { id: string; name: string } }>("GET", `/share/${encodeURIComponent(token)}`),

  /** Saved versions, newest first. */
  versions: (fileId: string) =>
    request<{ versions: VersionInfo[] }>("GET", `/files/${fileId}/versions`),
  /** Saves the file as it is now under a name (or names the version that already holds it). */
  saveVersion: (fileId: string, body: { name: string; description?: string }) =>
    request<{ version: VersionInfo }>("POST", `/files/${fileId}/versions`, body),
  /** Renames a version, or un-names it with `name: null`. */
  updateVersion: (
    fileId: string,
    versionId: string,
    body: { name?: string | null; description?: string | null },
  ) => request<{ version: VersionInfo }>("PATCH", `/files/${fileId}/versions/${versionId}`, body),
  /** The file's nodes as they were in a version. */
  versionNodes: async (fileId: string, versionId: string) =>
    (
      await request<{ revn: number; nodes: NodeRecord[] }>(
        "GET",
        `/files/${fileId}/versions/${versionId}/snapshot`,
      )
    ).nodes,
  /** Publishes the file as a team library (decision 0010): a named version, and what it offers. */
  publishLibrary: (fileId: string, body: { description?: string }) =>
    request<{ publish: LibraryPublish }>("POST", `/files/${fileId}/library/publish`, body),
  /** One publish of a library, however old. */
  libraryPublish: (fileId: string, publishId: string) =>
    request<{ publish: LibraryPublish }>(
      "GET",
      `/files/${fileId}/library/publishes/${encodeURIComponent(publishId)}`,
    ),
  /** A file's publishes as a library, newest first. */
  libraryPublishes: (fileId: string) =>
    request<{ publishes: LibraryPublish[] }>("GET", `/files/${fileId}/library`),
  /** The team libraries a file can use: the latest publish of each. */
  availableLibraries: (fileId: string) =>
    request<{ libraries: LibraryPublish[] }>("GET", `/files/${fileId}/libraries`),
  /** Restores the whole file. `sessionId` is this tab's, so the room doesn't also notify it. */
  restoreVersion: (fileId: string, versionId: string, sessionId: string | null) =>
    request<RestoreResult>("POST", `/files/${fileId}/versions/${versionId}/restore`, {
      sessionId,
    }),
};

export interface RestoreResult {
  readonly revn: number;
  /** The version saved just before restoring: restore it to undo. */
  readonly restorePoint: string;
  /** Operations applied; 0 when the file already matched. */
  readonly changed: number;
  /** Values the current schema refused and the restore left out. */
  readonly dropped: number;
}
