/** What the editor says when your access to a file changes while it's open. */
import type { ServerMessage } from "@drawpane/model";

/**
 * Said when your role on the team changes while you have the file open: by
 * someone else ("Ana made you a viewer"), or by you in another tab ("You're
 * now an editor"), and what it means for this file.
 */
export function roleChangeNotice(
  change: Extract<ServerMessage, { t: "role" }>,
  me: string | null,
): string {
  const byYou = change.by.id === me;
  const made = (role: string) =>
    byYou ? `You're now ${role} of this team` : `${change.by.name} made you ${role}`;
  switch (change.role) {
    case "viewer":
      return `${made("a viewer")}. You can still view, comment and inspect.`;
    case "editor":
      return change.previous === "viewer"
        ? `${made("an editor")}. You can edit this file now.`
        : `${made("an editor")}. You can still edit, but not manage the team.`;
    case "owner":
      return `${made("an owner")}.`;
  }
}
