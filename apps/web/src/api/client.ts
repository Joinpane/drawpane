/** Typed client for the Worker's REST API. Errors carry the server's sentence. */

export type Role = "owner" | "editor" | "viewer";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}
export interface Team {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
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
}
export interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: number;
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
  projectFiles: (projectId: string) =>
    request<{ files: FileMeta[] }>("GET", `/projects/${projectId}/files`),
  file: (fileId: string) =>
    request<{ file: FileMeta; role: Role; project: { id: string; name: string } | null }>(
      "GET",
      `/files/${fileId}`,
    ),
  members: (teamId: string) => request<{ members: Member[] }>("GET", `/teams/${teamId}/members`),

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
};
