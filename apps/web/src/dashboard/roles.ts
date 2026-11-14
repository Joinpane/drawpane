/** What each team role is called, and what it lets someone do (enforced in the Worker's api/access.ts). */
import type { Role } from "../api/client";

export const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

export const ROLE_ABILITIES: Record<Role, string> = {
  owner: "Invites people, changes roles, deletes projects and files for good",
  editor: "Creates, edits and imports files; shares prototypes; uploads fonts",
  viewer: "Views, comments, plays prototypes, inspects and exports",
};

/** Most first: owners, then editors, then viewers. */
export const ROLES: readonly Role[] = ["owner", "editor", "viewer"];
