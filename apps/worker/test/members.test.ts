import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedInUser } from "./helpers";

interface Member {
  id: string;
  name: string;
  role: string;
  passkeys: number;
  providers: string[];
  lastSignedInAt: number | null;
}
interface Invite {
  id: string;
  role: string;
  note: string | null;
  createdBy: string;
  expiresAt: number;
}

describe("team members", () => {
  it("lists everyone with how they sign in and when they last did, and counts them", async () => {
    const owner = await signedInUser("Ana Lima");
    const lena = await signedInUser("Lena Park", "editor", owner.teamId);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO passkeys (id, user_id, public_key, device_type, created_at, last_used_at) VALUES ('pk-lena', ?, x'00', 'multiDevice', ?, ?)",
      ).bind(lena.userId, now, now + 5_000),
      env.DB.prepare(
        "INSERT INTO oauth_identities (provider, subject, user_id, label, created_at, last_used_at) VALUES ('github', '1', ?, '@lena', ?, ?)",
      ).bind(lena.userId, now, now),
    ]);
    const { members } = await owner.browser.json<{ members: Member[] }>(
      `/api/teams/${owner.teamId}/members`,
    );
    expect(members.map((m) => [m.name, m.role])).toEqual([
      ["Ana Lima", "owner"],
      ["Lena Park", "editor"],
    ]);
    // Account details are for owners: teammates see who's on the team and their roles.
    const asEditor = await lena.browser.json<{ members: Record<string, unknown>[] }>(
      `/api/teams/${owner.teamId}/members`,
    );
    expect(asEditor.members.map((m) => [m.name, m.role])).toEqual([
      ["Ana Lima", "owner"],
      ["Lena Park", "editor"],
    ]);
    expect(asEditor.members.every((m) => !("lastSignedInAt" in m) && !("providers" in m))).toBe(
      true,
    );
    const shown = members.find((m) => m.id === lena.userId);
    expect(shown).toMatchObject({
      passkeys: 1,
      providers: ["github"],
      lastSignedInAt: now + 5_000,
    });
    // A session counts as signing in, too.
    expect(members.find((m) => m.id === owner.userId)?.lastSignedInAt).toBeGreaterThan(0);

    const { teams } = await owner.browser.json<{ teams: Array<{ members: number }> }>("/api/teams");
    expect(teams[0]?.members).toBe(2);
  });

  it("shows an owner the pending invites, with a note, and takes one back", async () => {
    const owner = await signedInUser("Ana Lima");
    const created = await owner.browser.json<{ token: string }>(
      `/api/teams/${owner.teamId}/invites`,
      { method: "POST", json: { role: "viewer", note: "  Lee, research  " } },
    );
    await owner.browser.json(`/api/teams/${owner.teamId}/invites`, {
      method: "POST",
      json: { role: "editor", note: "" },
    });
    const list = () =>
      owner.browser.json<{ invites: Invite[] }>(`/api/teams/${owner.teamId}/invites`);
    const { invites } = await list();
    expect(invites.map((i) => [i.role, i.note, i.createdBy])).toEqual([
      ["editor", null, "Ana Lima"],
      ["viewer", "Lee, research", "Ana Lima"],
    ]);
    // Listing never hands out a working link: the id is the token's hash.
    expect(invites.some((i) => i.id === created.token)).toBe(false);

    const lee = invites.find((i) => i.note === "Lee, research") as Invite;
    await owner.browser.json(`/api/teams/${owner.teamId}/invites/${lee.id}`, {
      method: "DELETE",
    });
    expect((await list()).invites).toHaveLength(1);
    const guest = await signedInUser("Lee");
    expect((await guest.browser.fetch(`/api/invites/${created.token}`)).status).toBe(404);
    const again = await owner.browser.fetch(`/api/teams/${owner.teamId}/invites/${lee.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("keeps invites and member changes to owners", async () => {
    const owner = await signedInUser("Ana Lima");
    const editor = await signedInUser("Lena Park", "editor", owner.teamId);
    const viewer = await signedInUser("Mo", "viewer", owner.teamId);
    expect((await editor.browser.fetch(`/api/teams/${owner.teamId}/invites`)).status).toBe(403);
    const promote = await editor.browser.fetch(
      `/api/teams/${owner.teamId}/members/${viewer.userId}`,
      { method: "PATCH", json: { role: "owner" } },
    );
    expect(promote.status).toBe(403);
    // Anyone can leave; only owners remove others.
    const remove = await editor.browser.fetch(
      `/api/teams/${owner.teamId}/members/${viewer.userId}`,
      { method: "DELETE" },
    );
    expect(remove.status).toBe(403);
    await viewer.browser.json(`/api/teams/${owner.teamId}/members/${viewer.userId}`, {
      method: "DELETE",
    });
    // The last owner can't step down or leave.
    const leave = await owner.browser.fetch(`/api/teams/${owner.teamId}/members/${owner.userId}`, {
      method: "DELETE",
    });
    expect(leave.status).toBe(409);
    const note = await owner.browser.fetch(`/api/teams/${owner.teamId}/invites`, {
      method: "POST",
      json: { note: "x".repeat(81) },
    });
    expect(note.status).toBe(400);
  });

  it("keeps an owner when two owners step down or remove each other at once", async () => {
    const ana = await signedInUser("Ana Lima");
    const bo = await signedInUser("Bo Chen", "owner", ana.teamId);
    const owners = () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'")
        .bind(ana.teamId)
        .first<{ n: number }>()
        .then((r) => r?.n ?? 0);
    const patch = (who: typeof ana, userId: string) =>
      who.browser.fetch(`/api/teams/${ana.teamId}/members/${userId}`, {
        method: "PATCH",
        json: { role: "editor" },
      });
    // Each steps down, at the same moment: one goes through, one is refused.
    const stepDown = await Promise.all([patch(ana, ana.userId), patch(bo, bo.userId)]);
    expect(stepDown.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await owners()).toBe(1);

    // Two owners again, each removing the other at once.
    await env.DB.prepare("UPDATE team_members SET role = 'owner' WHERE team_id = ?")
      .bind(ana.teamId)
      .run();
    const remove = (who: typeof ana, userId: string) =>
      who.browser.fetch(`/api/teams/${ana.teamId}/members/${userId}`, { method: "DELETE" });
    const removals = await Promise.all([remove(ana, bo.userId), remove(bo, ana.userId)]);
    expect(removals.map((r) => r.status)).toContain(200);
    expect(await owners()).toBe(1);
  });
});
