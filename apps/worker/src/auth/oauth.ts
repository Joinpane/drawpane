/**
 * Sign in with GitHub or Google (OAuth 2, authorization code with PKCE).
 *
 * `start` sends the browser to the provider with a random `state` and PKCE
 * challenge, keeping them (and what the person was doing) in a short-lived
 * signed cookie. `callback` checks the state, trades the code for a token,
 * reads the profile, and then, in order:
 *
 * 1. a provider account already linked: signs that user in (or, when
 *    linking from settings, confirms it's theirs);
 * 2. linking from settings: links it to the signed-in user;
 * 3. a verified email matching an account: links it and signs in;
 * 4. a valid invite: creates the account and joins the team;
 * 5. otherwise nobody is let in: accounts come from invites, and the first
 *    one from the setup token, as with passkeys.
 *
 * Every outcome is a redirect back into the app; failures carry a short
 * code (`?error=no-account`) the page turns into words.
 */
import { newId } from "@drawpane/model";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext, Role, User } from "../env";
import {
  bytesToBase64Url,
  randomToken,
  sha256Hex,
  signPayload,
  verifyPayload,
} from "../lib/crypto";
import { notFound } from "../lib/http";
import {
  exchangeCode,
  type Profile,
  type Provider,
  type ProviderId,
  provider,
  providers,
} from "./oauth-providers";
import { publicOrigins } from "./passkeys";
import { createSession } from "./session";

const STATE_COOKIE = "__Host-dp_oauth";
const STATE_TTL_MS = 10 * 60_000;

/** Why a sign-in didn't go through, as the app shows it. */
export type OAuthError =
  | "denied"
  | "expired"
  | "provider"
  | "no-email"
  | "no-account"
  | "taken"
  | "invite";

interface Pending {
  readonly provider: ProviderId;
  readonly state: string;
  readonly verifier: string;
  readonly exp: number;
  /** Linking from account settings: the signed-in user. */
  readonly linkTo: string | null;
  /** SHA-256 of an invite token being accepted, if any. */
  readonly invite: string | null;
  /** Where to go afterwards (a path in this app). */
  readonly next: string;
  /** Where failures go: the sign-in page, the invite, or settings. */
  readonly back: string;
}

/** A path inside this app, or "/" for anything else (no open redirects). */
export function safePath(value: string | undefined | null, fallback = "/"): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return fallback;
  return value.slice(0, 512);
}

function redirectUri(c: Context<AppContext>, id: ProviderId): string {
  return `${publicOrigins(c)[0]}/api/auth/oauth/${id}/callback`;
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

function fail(c: Context<AppContext>, back: string, error: OAuthError, p: ProviderId) {
  const url = new URL(back, "https://x");
  url.searchParams.set("error", error);
  url.searchParams.set("provider", p);
  return c.redirect(`${url.pathname}${url.search}`, 302);
}

interface InviteRow {
  id: string;
  team_id: string;
  role: Role;
}

async function liveInvite(c: Context<AppContext>, id: string | null): Promise<InviteRow | null> {
  if (!id) return null;
  return c.env.DB.prepare(
    "SELECT id, team_id, role FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(id, Date.now())
    .first<InviteRow>();
}

/** Statements that use an invite for `userId`: they join its team. */
function acceptInvite(c: Context<AppContext>, invite: InviteRow, userId: string, now: number) {
  return [
    c.env.DB.prepare(
      "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL",
    ).bind(now, userId, invite.id),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).bind(invite.team_id, userId, invite.role, now),
  ];
}

function linkIdentity(
  c: Context<AppContext>,
  p: Provider,
  profile: Profile,
  userId: string,
  now: number,
) {
  return c.env.DB.prepare(
    `INSERT INTO oauth_identities (provider, subject, user_id, label, email, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.id, profile.subject, userId, profile.label, profile.email, now, now);
}

export const oauth = new Hono<AppContext>()
  /** The providers this instance offers, for the sign-in page. */
  .get("/providers", (c) =>
    c.json({ providers: providers(c.env).map((p) => ({ id: p.id, name: p.name })) }),
  )

  .get("/:provider/start", async (c) => {
    const p = provider(c.env, c.req.param("provider"));
    if (!p) throw notFound("That sign-in method isn't set up here.");
    const intent = c.req.query("intent");
    const user = c.get("user");
    const inviteToken = c.req.query("invite");
    const next = safePath(c.req.query("next"));
    const linking = intent === "link";
    if (linking && !user) return fail(c, "/signin", "expired", p.id);
    const back = linking
      ? next
      : inviteToken
        ? `/invite/${encodeURIComponent(inviteToken)}`
        : "/signin";
    const verifier = randomToken(48);
    const pending: Pending = {
      provider: p.id,
      state: randomToken(),
      verifier,
      exp: Date.now() + STATE_TTL_MS,
      linkTo: linking && user ? user.id : null,
      invite: inviteToken ? await sha256Hex(inviteToken) : null,
      next,
      back,
    };
    // Lax: the provider sends the browser back with a top-level GET, which carries it.
    setCookie(c, STATE_COOKIE, await signPayload(c.env.SESSION_SECRET, pending), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: STATE_TTL_MS / 1000,
    });
    const url = new URL(p.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: p.clientId,
      redirect_uri: redirectUri(c, p.id),
      scope: p.scope,
      state: pending.state,
      code_challenge: await challengeOf(verifier),
      code_challenge_method: "S256",
      ...p.authorizeParams,
    }).toString();
    return c.redirect(url.toString(), 302);
  })

  .get("/:provider/callback", async (c) => {
    const id = c.req.param("provider");
    const p = provider(c.env, id);
    if (!p) throw notFound("That sign-in method isn't set up here.");
    const token = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    const pending = token ? await verifyPayload<Pending>(c.env.SESSION_SECRET, token) : null;
    const state = c.req.query("state");
    if (
      !pending ||
      pending.provider !== p.id ||
      pending.exp < Date.now() ||
      !state ||
      state !== pending.state
    )
      return fail(c, "/signin", "expired", p.id);
    const back = pending.back;
    if (c.req.query("error")) return fail(c, back, "denied", p.id);
    const code = c.req.query("code");
    if (!code) return fail(c, back, "expired", p.id);

    let profile: Profile;
    try {
      const accessToken = await exchangeCode(p, code, redirectUri(c, p.id), pending.verifier);
      profile = await p.profile(accessToken);
    } catch (error) {
      console.warn("oauth", p.id, error);
      return fail(c, back, "provider", p.id);
    }

    const db = c.env.DB;
    const now = Date.now();
    const linked = await db
      .prepare("SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?")
      .bind(p.id, profile.subject)
      .first<{ user_id: string }>();
    const invite = await liveInvite(c, pending.invite);
    if (pending.invite && !invite) return fail(c, back, "invite", p.id);

    // Linking from settings: still signed in as the same person.
    if (pending.linkTo) {
      const user = c.get("user");
      if (!user || user.id !== pending.linkTo) return fail(c, "/signin", "expired", p.id);
      if (linked && linked.user_id !== user.id) return fail(c, back, "taken", p.id);
      if (!linked) await linkIdentity(c, p, profile, user.id, now).run();
      return c.redirect(pending.next, 302);
    }

    let userId: string | null = linked?.user_id ?? null;
    const statements: D1PreparedStatement[] = [];
    if (userId) {
      statements.push(
        db
          .prepare(
            "UPDATE oauth_identities SET last_used_at = ?, label = ? WHERE provider = ? AND subject = ?",
          )
          .bind(now, profile.label, p.id, profile.subject),
      );
    } else {
      if (!profile.email) return fail(c, back, "no-email", p.id);
      const existing = await db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(profile.email)
        .first<{ id: string }>();
      if (existing) {
        // The provider vouches for the address: it's the same person.
        userId = existing.id;
      } else if (invite) {
        userId = newId();
        statements.push(
          db
            .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
            .bind(userId, profile.email, profile.name || profile.email, now),
        );
      } else {
        return fail(c, back, "no-account", p.id);
      }
      statements.push(linkIdentity(c, p, profile, userId, now));
    }
    if (invite) statements.push(...acceptInvite(c, invite, userId, now));
    await db.batch(statements);
    await createSession(c, userId);
    return c.redirect(invite ? "/" : pending.next, 302);
  });

/** What account settings show about a user's ways of signing in. */
export async function signInMethods(c: Context<AppContext>, user: User) {
  const [passkeyRows, identityRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt,
              last_used_at AS lastUsedAt
         FROM passkeys WHERE user_id = ? ORDER BY created_at`,
    )
      .bind(user.id)
      .all<{
        id: string;
        deviceType: string;
        backedUp: number;
        createdAt: number;
        lastUsedAt: number | null;
      }>(),
    c.env.DB.prepare(
      `SELECT provider, label, created_at AS createdAt, last_used_at AS lastUsedAt
         FROM oauth_identities WHERE user_id = ? ORDER BY created_at`,
    )
      .bind(user.id)
      .all<{ provider: ProviderId; label: string; createdAt: number; lastUsedAt: number }>(),
  ]);
  return {
    passkeys: passkeyRows.results.map((r) => ({ ...r, backedUp: r.backedUp === 1 })),
    identities: identityRows.results,
    providers: providers(c.env).map((p) => ({ id: p.id, name: p.name })),
  };
}
