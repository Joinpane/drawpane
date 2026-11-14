/**
 * Passkey (WebAuthn) sign-up and sign-in. There are no passwords.
 *
 * The first account on a fresh install needs `SETUP_TOKEN`, so nobody can
 * claim an instance before its owner does. Every later account needs an
 * invite. Challenges travel in a short-lived signed cookie, so no challenge
 * table is needed.
 */
import { newId } from "@drawpane/model";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppContext, Role } from "../env";
import { sha256Hex, signPayload, verifyPayload } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, unauthorized } from "../lib/http";
import { createSession, destroySession, requireUser } from "./session";

const CHALLENGE_COOKIE = "__Host-dp_challenge";
const CHALLENGE_TTL_MS = 5 * 60_000;

type Challenge =
  | {
      purpose: "register";
      challenge: string;
      exp: number;
      userId: string;
      name: string;
      email: string;
      /** SHA-256 of the invite token, or null for the first account. */
      invite: string | null;
    }
  | { purpose: "login"; challenge: string; exp: number }
  /** A signed-in person adding another passkey to their account. */
  | { purpose: "add"; challenge: string; exp: number; userId: string };

/**
 * The relying party for this request: the site the passkey belongs to and the
 * origin the browser must report. Derived from the request, or from
 * `PUBLIC_ORIGIN` in local development.
 */
export function relyingParty(c: Context<AppContext>) {
  const origin = c.req.header("origin");
  const allowed = publicOrigins(c);
  if (!origin || !allowed.includes(origin)) throw forbidden("Cross-origin sign-in isn't allowed.");
  // Behind a dev proxy the browser's origin can differ from the Origin header
  // the Worker sees, so accept any configured origin on the same site.
  return { rpID: new URL(origin).hostname, origin: allowed, rpName: c.env.RP_NAME ?? "Drawpane" };
}

/** Origins this instance answers to. */
export function publicOrigins(c: Context<AppContext>): string[] {
  if (c.env.PUBLIC_ORIGIN)
    return c.env.PUBLIC_ORIGIN.split(",").map((o) => o.trim().replace(/\/$/, ""));
  return [new URL(c.req.url).origin];
}

async function issueChallenge(c: Context<AppContext>, challenge: Challenge): Promise<void> {
  setCookie(c, CHALLENGE_COOKIE, await signPayload(c.env.SESSION_SECRET, challenge), {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

async function takeChallenge<P extends Challenge["purpose"]>(
  c: Context<AppContext>,
  purpose: P,
): Promise<Extract<Challenge, { purpose: P }>> {
  const token = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: true });
  const challenge = token ? await verifyPayload<Challenge>(c.env.SESSION_SECRET, token) : null;
  if (!challenge || challenge.purpose !== purpose || challenge.exp < Date.now()) {
    throw badRequest("That sign-in attempt expired. Try again.");
  }
  return challenge as Extract<Challenge, { purpose: P }>;
}

async function userCount(c: Context<AppContext>): Promise<number> {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface InviteRow {
  id: string;
  team_id: string;
  role: Role;
}

async function findInvite(c: Context<AppContext>, token: string): Promise<InviteRow | null> {
  return c.env.DB.prepare(
    "SELECT id, team_id, role FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(token), Date.now())
    .first<InviteRow>();
}

const RegisterStart = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80),
  email: z.email("Enter a valid email address.").max(254),
  setupToken: z.string().max(256).optional(),
  inviteToken: z.string().max(256).optional(),
});

export const passkeys = new Hono<AppContext>()
  .post("/register/options", async (c) => {
    const parsed = RegisterStart.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");
    const { name, email, setupToken, inviteToken } = parsed.data;
    const { rpID, rpName } = relyingParty(c);

    let invite: string | null = null;
    if ((await userCount(c)) === 0) {
      if (!c.env.SETUP_TOKEN) {
        throw new HttpError(
          503,
          "internal",
          "This install has no SETUP_TOKEN set. Set one with `wrangler secret put SETUP_TOKEN`.",
        );
      }
      if (!setupToken || !timingSafeEqual(setupToken, c.env.SETUP_TOKEN)) {
        throw forbidden(
          "That setup token isn't right. It was printed when this instance was deployed.",
        );
      }
    } else {
      if (!inviteToken) throw forbidden("You need an invite to join. Ask a teammate for a link.");
      const row = await findInvite(c, inviteToken);
      if (!row) throw forbidden("That invite has expired or was already used. Ask for a new link.");
      invite = row.id;
    }

    const existing = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?")
      .bind(email)
      .first();
    if (existing) throw conflict("That email already has an account. Sign in instead.");

    const userId = newId();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: email,
      userDisplayName: name,
      userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    await issueChallenge(c, {
      purpose: "register",
      challenge: options.challenge,
      exp: Date.now() + CHALLENGE_TTL_MS,
      userId,
      name,
      email,
      invite,
    });
    return c.json(options);
  })

  .post("/register/verify", async (c) => {
    const pending = await takeChallenge(c, "register");
    const { rpID, origin } = relyingParty(c);
    const response = (await c.req.json().catch(() => null)) as RegistrationResponseJSON | null;
    if (!response) throw badRequest("Invalid request.");

    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    }).catch(() => null);
    if (!result?.verified) throw badRequest("Your passkey couldn't be verified. Try again.");

    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const now = Date.now();
    const db = c.env.DB;
    const statements: D1PreparedStatement[] = [
      db
        .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
        .bind(pending.userId, pending.email, pending.name, now),
      db
        .prepare(
          `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          credential.id,
          pending.userId,
          credential.publicKey,
          credential.counter,
          credential.transports ? JSON.stringify(credential.transports) : null,
          credentialDeviceType,
          credentialBackedUp ? 1 : 0,
          now,
        ),
    ];

    if (pending.invite === null) {
      if ((await userCount(c)) > 0)
        throw conflict("This instance was already set up. Sign in instead.");
      const teamId = newId();
      statements.push(
        // Whoever sets the instance up runs it.
        db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(pending.userId),
        db
          .prepare("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
          .bind(teamId, `${pending.name.split(" ")[0]}'s team`, now),
        db
          .prepare(
            "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
          )
          .bind(teamId, pending.userId, now),
        db
          .prepare(
            "INSERT INTO projects (id, team_id, name, created_at, updated_at) VALUES (?, ?, 'Drafts', ?, ?)",
          )
          .bind(newId(), teamId, now, now),
      );
    } else {
      const invite = await db
        .prepare(
          "SELECT team_id, role FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?",
        )
        .bind(pending.invite, now)
        .first<{ team_id: string; role: Role }>();
      if (!invite)
        throw forbidden("That invite has expired or was already used. Ask for a new link.");
      statements.push(
        db
          .prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL")
          .bind(now, pending.userId, pending.invite),
        db
          .prepare(
            "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(invite.team_id, pending.userId, invite.role, now),
      );
    }

    try {
      await db.batch(statements);
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw conflict("That email already has an account. Sign in instead.");
      throw error;
    }
    await createSession(c, pending.userId);
    // The same user the session route reports, so the app needn't ask again.
    return c.json({
      user: {
        id: pending.userId,
        email: pending.email,
        name: pending.name,
        isAdmin: pending.invite === null,
      },
    });
  })

  .post("/login/options", async (c) => {
    const { rpID } = relyingParty(c);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    await issueChallenge(c, {
      purpose: "login",
      challenge: options.challenge,
      exp: Date.now() + CHALLENGE_TTL_MS,
    });
    return c.json(options);
  })

  .post("/login/verify", async (c) => {
    const pending = await takeChallenge(c, "login");
    const { rpID, origin } = relyingParty(c);
    const response = (await c.req.json().catch(() => null)) as AuthenticationResponseJSON | null;
    if (!response || typeof response.id !== "string") throw badRequest("Invalid request.");

    const row = await c.env.DB.prepare(
      `SELECT p.id, p.public_key, p.counter, p.transports, u.id AS user_id, u.email, u.name, u.is_admin
         FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    )
      .bind(response.id)
      .first<{
        id: string;
        public_key: ArrayBuffer;
        counter: number;
        transports: string | null;
        user_id: string;
        email: string;
        name: string;
        is_admin: number;
      }>();
    if (!row)
      throw unauthorized("This passkey isn't registered here. Use another, or ask for an invite.");

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        ...(row.transports ? { transports: JSON.parse(row.transports) as string[] } : {}),
      },
    }).catch(() => null);
    if (!result?.verified) throw unauthorized("Your passkey couldn't be verified. Try again.");

    await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
      .bind(result.authenticationInfo.newCounter, Date.now(), row.id)
      .run();
    await createSession(c, row.user_id);
    return c.json({
      user: { id: row.user_id, email: row.email, name: row.name, isAdmin: row.is_admin === 1 },
    });
  })

  /** Adding a passkey to the signed-in account (say, after joining with GitHub). */
  .post("/passkeys/options", async (c) => {
    const user = requireUser(c);
    const { rpID, rpName } = relyingParty(c);
    const { results } = await c.env.DB.prepare(
      "SELECT id, transports FROM passkeys WHERE user_id = ?",
    )
      .bind(user.id)
      .all<{ id: string; transports: string | null }>();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      // Not the same authenticator twice.
      excludeCredentials: results.map((r) => ({
        id: r.id,
        ...(r.transports ? { transports: JSON.parse(r.transports) } : {}),
      })),
    });
    await issueChallenge(c, {
      purpose: "add",
      challenge: options.challenge,
      exp: Date.now() + CHALLENGE_TTL_MS,
      userId: user.id,
    });
    return c.json(options);
  })

  .post("/passkeys/verify", async (c) => {
    const user = requireUser(c);
    const pending = await takeChallenge(c, "add");
    if (pending.userId !== user.id) throw badRequest("That attempt was for another account.");
    const { rpID, origin } = relyingParty(c);
    const response = (await c.req.json().catch(() => null)) as RegistrationResponseJSON | null;
    if (!response) throw badRequest("Invalid request.");
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    }).catch(() => null);
    if (!result?.verified) throw badRequest("Your passkey couldn't be verified. Try again.");
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    await c.env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        credential.id,
        user.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        Date.now(),
      )
      .run();
    return c.json({ ok: true });
  })

  .post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });
