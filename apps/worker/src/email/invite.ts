/**
 * The email an invite travels in (docs/decisions/0006-email.md): who's
 * asking, to which team, as what, and one button. Replies go to the person
 * who invited, not to the instance's sender address.
 */
import type { Role } from "../env";
import { emailButton, emailPage, emailRow, emailText, escapeHtml } from "./layout";
import type { EmailMessage } from "./message";

/** What each role lets someone do, in a phrase after "to": the app says the same (roles.ts). */
const ROLE_PHRASES: Record<Role, string> = {
  owner: "as an owner: edit files, invite people and run the team",
  editor: "as an editor: create, edit and import files",
  viewer: "as a viewer: view, comment, play prototypes and export",
};

export interface InviteEmail {
  readonly to: string;
  readonly url: string;
  readonly teamName: string;
  readonly role: Role;
  readonly expiresAt: number;
  readonly inviter: { readonly name: string; readonly email: string };
}

/** "Thursday, November 21": when the link stops working, in plain words (UTC, as the server can't know theirs). */
const day = (at: number) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(at);

export function inviteEmail(invite: InviteEmail): EmailMessage {
  const { inviter, teamName, url } = invite;
  const host = new URL(url).host;
  const lead = `${inviter.name} invited you to ${teamName} on Drawpane, ${ROLE_PHRASES[invite.role]}.`;
  const terms = `The link works once, until ${day(invite.expiresAt)}. Opening it sets up your account.`;
  const why = `${inviter.name} (${inviter.email}) sent this from Drawpane at ${host}. Not expecting it? You can ignore it: nothing happens unless you open the link.`;

  const text = [lead, "", `Join ${teamName}: ${url}`, "", terms, "", "—", why].join("\n");

  const html = emailPage({
    heading: `Join ${teamName} on Drawpane`,
    preheader: `${inviter.name} invited you, ${ROLE_PHRASES[invite.role].split(":")[0]}.`,
    rows: [
      emailRow(
        [
          emailText(lead, "lead"),
          `<div style="margin-top:16px">${emailButton(url, `Join ${teamName}`)}</div>`,
          emailText(terms, "note", { gap: 16 }),
        ].join(""),
      ),
      emailRow(
        `${emailText("Or paste this link into your browser:", "note")}${emailText(url, "url", { gap: 2 })}`,
        { divider: true },
      ),
    ],
    footer: escapeHtml(why),
  });

  return {
    to: [invite.to],
    subject: `${inviter.name} invited you to ${teamName} on Drawpane`,
    text,
    html,
    replyTo: inviter.email,
  };
}
