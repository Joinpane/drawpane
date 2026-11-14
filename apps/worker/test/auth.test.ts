import { describe, expect, it } from "vitest";
import { SoftPasskey } from "./authenticator";
import { Browser, ORIGIN, signedInUser } from "./helpers";

describe("first-run setup with a passkey", () => {
  it("needs the setup token, then signs in with the same passkey later", async () => {
    const browser = new Browser();
    expect(await browser.json("/api/session")).toEqual({ user: null, needsSetup: true });

    const wrong = await browser.fetch("/api/auth/register/options", {
      method: "POST",
      json: { name: "Ana Lima", email: "ana@example.com", setupToken: "nope" },
    });
    expect(wrong.status).toBe(403);

    const options = await browser.json<{
      challenge: string;
      rp: { id: string };
      user: { id: string };
    }>("/api/auth/register/options", {
      method: "POST",
      json: { name: "Ana Lima", email: "ana@example.com", setupToken: "test-setup-token" },
    });
    expect(options.rp.id).toBe(new URL(ORIGIN).hostname);

    const passkey = new SoftPasskey(ORIGIN);
    const { user } = await browser.json<{ user: { name: string } }>("/api/auth/register/verify", {
      method: "POST",
      json: await passkey.create(options),
    });
    expect(user.name).toBe("Ana Lima");

    const session = await browser.json<{ user: { email: string; isAdmin: boolean } }>(
      "/api/session",
    );
    expect(session.user.email).toBe("ana@example.com");
    // Whoever sets the instance up runs it.
    expect(session.user.isAdmin).toBe(true);
    const { teams } = await browser.json<{ teams: Array<{ role: string }> }>("/api/teams");
    expect(teams).toHaveLength(1);
    expect(teams[0]?.role).toBe("owner");

    await browser.json("/api/auth/logout", { method: "POST" });
    expect((await browser.json<{ user: unknown }>("/api/session")).user).toBeNull();

    // A second setup attempt is refused once an account exists.
    const again = await browser.fetch("/api/auth/register/options", {
      method: "POST",
      json: { name: "Mallory", email: "m@example.com", setupToken: "test-setup-token" },
    });
    expect(again.status).toBe(403);

    const loginOptions = await browser.json<{ challenge: string; rpId: string }>(
      "/api/auth/login/options",
      {
        method: "POST",
        json: {},
      },
    );
    const assertion = await passkey.get(loginOptions);
    const signedIn = await browser.json<{ user: { email: string } }>("/api/auth/login/verify", {
      method: "POST",
      json: assertion,
    });
    expect(signedIn.user.email).toBe("ana@example.com");

    // The challenge cookie is single-use, so replaying the assertion fails.
    const replay = await browser.fetch("/api/auth/login/verify", {
      method: "POST",
      json: assertion,
    });
    expect(replay.status).toBe(400);
  });
});

describe("invites", () => {
  it("lets an invited person register and join with the invite's role", async () => {
    const owner = await signedInUser();
    const invite = await owner.browser.json<{ token: string; url: string }>(
      `/api/teams/${owner.teamId}/invites`,
      {
        method: "POST",
        json: { role: "viewer" },
      },
    );
    expect(invite.url).toBe(`${ORIGIN}/invite/${invite.token}`);

    const guest = new Browser();
    expect(await guest.json(`/api/invites/${invite.token}`)).toMatchObject({
      teamName: "Team",
      role: "viewer",
    });

    const noInvite = await guest.fetch("/api/auth/register/options", {
      method: "POST",
      json: { name: "Guest", email: "guest@example.com" },
    });
    expect(noInvite.status).toBe(403);

    const options = await guest.json<{
      challenge: string;
      rp: { id: string };
      user: { id: string };
    }>("/api/auth/register/options", {
      method: "POST",
      json: { name: "Guest", email: "guest@example.com", inviteToken: invite.token },
    });
    await guest.json("/api/auth/register/verify", {
      method: "POST",
      json: await new SoftPasskey(ORIGIN).create(options),
    });
    // An invited person isn't the instance's admin.
    expect((await guest.json<{ user: { isAdmin: boolean } }>("/api/session")).user.isAdmin).toBe(
      false,
    );
    const { teams } = await guest.json<{ teams: Array<{ id: string; role: string }> }>(
      "/api/teams",
    );
    expect(teams).toEqual([expect.objectContaining({ id: owner.teamId, role: "viewer" })]);

    // The invite is single-use.
    expect((await guest.fetch(`/api/invites/${invite.token}`)).status).toBe(404);
  });
});

describe("request hygiene", () => {
  it("refuses cross-origin writes", async () => {
    const { browser, teamId } = await signedInUser();
    const response = await browser.fetch(`/api/teams/${teamId}/projects`, {
      method: "POST",
      json: { name: "Evil" },
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("returns readable JSON errors", async () => {
    const anonymous = new Browser();
    const response = await anonymous.fetch("/api/teams");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Sign in to continue." },
    });
  });
});
