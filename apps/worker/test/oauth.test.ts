import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safePath } from "../src/auth/oauth";
import { SESSION_COOKIE } from "../src/auth/session";
import { randomToken, sha256Hex } from "../src/lib/crypto";
import { Browser, ORIGIN, signedInUser } from "./helpers";

interface FakeAccount {
  id: number;
  login: string;
  name: string;
  emails: Array<{ email: string; primary: boolean; verified: boolean }>;
}

/** Stands in for GitHub: the token endpoint and the user API. Returns what it was asked. */
function stubGitHub(account: FakeAccount) {
  const seen: Array<{ url: string; body: string }> = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = String(init?.body ?? "");
      seen.push({ url, body });
      return new URLSearchParams(body).get("code") === "good"
        ? Response.json({ access_token: "gh-token", token_type: "bearer" })
        : Response.json({ error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") return Response.json(account);
    if (url === "https://api.github.com/user/emails") return Response.json(account.emails);
    return real(input, init);
  });
  return seen;
}

function stubGoogle(user: { sub: string; email: string; email_verified: boolean; name: string }) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "g-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(user);
    return real(input, init);
  });
}

afterEach(() => vi.restoreAllMocks());

/** Starts a sign-in in `browser` and returns the provider redirect and its state. */
async function start(browser: Browser, provider: string, query = "") {
  // Not followed: the redirect is the answer.
  const response = await browser.fetch(`/api/auth/oauth/${provider}/start${query}`, {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") as string);
  return { location, state: location.searchParams.get("state") as string };
}

async function callback(browser: Browser, provider: string, state: string, code = "good") {
  const response = await browser.fetch(
    `/api/auth/oauth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  expect(response.status).toBe(302);
  return response.headers.get("location") as string;
}

async function userWithEmail(email: string) {
  const id = `u-${randomToken(6)}`;
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, "Ana Lima", Date.now())
    .run();
  return id;
}

async function invite(teamId: string, createdBy: string) {
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO invites (id, team_id, role, created_by, created_at, expires_at) VALUES (?, ?, 'editor', ?, ?, ?)",
  )
    .bind(await sha256Hex(token), teamId, createdBy, Date.now(), Date.now() + 86_400_000)
    .run();
  return token;
}

const signedIn = async (browser: Browser) =>
  (await browser.json<{ user: { email: string } | null }>("/api/session")).user;

const ana = (overrides: Partial<FakeAccount> = {}): FakeAccount => ({
  id: 4242,
  login: "ana",
  name: "Ana Lima",
  emails: [{ email: "ana@studio.example", primary: true, verified: true }],
  ...overrides,
});

describe("signing in with GitHub", () => {
  it("lists the providers this instance has set up", async () => {
    const { providers } = await new Browser().json<{ providers: Array<{ id: string }> }>(
      "/api/auth/oauth/providers",
    );
    expect(providers.map((p) => p.id)).toEqual(["github", "google"]);
  });

  it("sends the browser to GitHub with a state and a PKCE challenge", async () => {
    const browser = new Browser();
    const { location, state } = await start(browser, "github", "?next=/t/x");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: "gh-client",
      redirect_uri: `${ORIGIN}/api/auth/oauth/github/callback`,
      response_type: "code",
      code_challenge_method: "S256",
    });
    expect(state.length).toBeGreaterThan(20);
    expect(browser.cookies.has("__Host-dp_oauth")).toBe(true);
  });

  it("links GitHub to the account with its verified email, signs in, and goes back", async () => {
    await userWithEmail("ana@studio.example");
    const seen = stubGitHub(ana());
    const browser = new Browser();
    const { state, location } = await start(browser, "github", "?next=/t/team");
    expect(await callback(browser, "github", state)).toBe("/t/team");
    expect((await signedIn(browser))?.email).toBe("ana@studio.example");
    // The code went back with the PKCE verifier that matches the challenge.
    const sent = new URLSearchParams(seen[0]?.body);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sent.get("code_verifier") ?? ""),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(location.searchParams.get("code_challenge"));

    // Next time the link is enough, whatever the email says now.
    vi.restoreAllMocks();
    stubGitHub(ana({ emails: [{ email: "new@else.example", primary: true, verified: true }] }));
    const again = new Browser();
    const second = await start(again, "github");
    expect(await callback(again, "github", second.state)).toBe("/");
    expect((await signedIn(again))?.email).toBe("ana@studio.example");
  });

  it("lets nobody in without an account or an invite", async () => {
    stubGitHub(
      ana({ id: 7, emails: [{ email: "stranger@else.example", primary: true, verified: true }] }),
    );
    const browser = new Browser();
    const { state } = await start(browser, "github");
    expect(await callback(browser, "github", state)).toBe(
      "/signin?error=no-account&provider=github",
    );
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("creates the account from an invite and joins the team", async () => {
    const owner = await signedInUser("Owner");
    const token = await invite(owner.teamId, owner.userId);
    stubGitHub(
      ana({
        id: 8,
        login: "bo",
        name: "Bo Chen",
        emails: [{ email: "bo@else.example", primary: true, verified: true }],
      }),
    );
    const browser = new Browser();
    const { state } = await start(browser, "github", `?invite=${token}`);
    expect(await callback(browser, "github", state)).toBe("/");
    expect((await signedIn(browser))?.email).toBe("bo@else.example");
    const member = await env.DB.prepare(
      "SELECT role FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE u.email = ? AND tm.team_id = ?",
    )
      .bind("bo@else.example", owner.teamId)
      .first<{ role: string }>();
    expect(member?.role).toBe("editor");
  });

  it("won't link an address GitHub hasn't verified", async () => {
    await userWithEmail("eve@studio.example");
    stubGitHub(
      ana({ id: 9, emails: [{ email: "eve@studio.example", primary: true, verified: false }] }),
    );
    const browser = new Browser();
    const { state } = await start(browser, "github");
    expect(await callback(browser, "github", state)).toBe("/signin?error=no-email&provider=github");
  });

  it("refuses a callback whose state doesn't match, or that GitHub turned down", async () => {
    stubGitHub(ana());
    const browser = new Browser();
    await start(browser, "github");
    expect(await callback(browser, "github", "forged")).toBe(
      "/signin?error=expired&provider=github",
    );
    // A different browser that never started has no state at all.
    const { state } = await start(browser, "github");
    expect(await callback(new Browser(), "github", state)).toBe(
      "/signin?error=expired&provider=github",
    );
    expect(await callback(browser, "github", state, "bad")).toBe(
      "/signin?error=provider&provider=github",
    );
  });

  it("never redirects outside the app", () => {
    expect(safePath("/t/abc?x=1")).toBe("/t/abc?x=1");
    expect(safePath("//evil.example")).toBe("/");
    expect(safePath("/\\evil.example")).toBe("/");
    expect(safePath("https://evil.example")).toBe("/");
  });
});

describe("signing in with Google", () => {
  it("signs in an account by its verified Google address", async () => {
    await userWithEmail("cy@studio.example");
    stubGoogle({ sub: "g-1", email: "cy@studio.example", email_verified: true, name: "Cy" });
    const browser = new Browser();
    const { location, state } = await start(browser, "google");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    await callback(browser, "google", state);
    expect((await signedIn(browser))?.email).toBe("cy@studio.example");
  });
});

describe("connected accounts", () => {
  it("connects GitHub from settings, and keeps the last way to sign in", async () => {
    const me = await signedInUser("Di Park");
    stubGitHub(
      ana({
        id: 11,
        login: "di",
        emails: [{ email: "di@other.example", primary: true, verified: true }],
      }),
    );
    const { state } = await start(me.browser, "github", "?intent=link&next=/settings");
    expect(await callback(me.browser, "github", state)).toBe("/settings");
    const methods = await me.browser.json<{
      identities: Array<{ provider: string; label: string }>;
    }>("/api/account");
    expect(methods.identities).toEqual([
      expect.objectContaining({ provider: "github", label: "@di" }),
    ]);
    // GitHub is Di's only way in (the test user has no passkey): it stays.
    const remove = await me.browser.fetch("/api/account/identities/github", { method: "DELETE" });
    expect(remove.status).toBe(409);
  });

  it("won't connect a GitHub account that already belongs to someone else", async () => {
    await userWithEmail("ann@studio.example");
    stubGitHub(
      ana({ id: 12, emails: [{ email: "ann@studio.example", primary: true, verified: true }] }),
    );
    const first = new Browser();
    await callback(first, "github", (await start(first, "github")).state);

    const other = await signedInUser("Ed");
    const { state } = await start(other.browser, "github", "?intent=link&next=/settings");
    expect(await callback(other.browser, "github", state)).toBe(
      "/settings?error=taken&provider=github",
    );
  });

  it("disconnects one way to sign in while another remains", async () => {
    const me = await signedInUser("Fay");
    await env.DB.prepare(
      "INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, created_at) VALUES (?, ?, ?, 0, 'multiDevice', 1, ?)",
    )
      .bind(`pk-${randomToken(6)}`, me.userId, new Uint8Array([1, 2, 3]), Date.now())
      .run();
    stubGitHub(
      ana({
        id: 13,
        login: "fay",
        emails: [{ email: "fay@other.example", primary: true, verified: true }],
      }),
    );
    const { state } = await start(me.browser, "github", "?intent=link&next=/settings");
    await callback(me.browser, "github", state);
    const remove = await me.browser.fetch("/api/account/identities/github", { method: "DELETE" });
    expect(remove.status).toBe(200);
    const { identities, passkeys } = await me.browser.json<{
      identities: unknown[];
      passkeys: unknown[];
    }>("/api/account");
    expect(identities).toEqual([]);
    expect(passkeys).toHaveLength(1);
  });
});
