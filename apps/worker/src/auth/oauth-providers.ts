/**
 * The sign-in providers Drawpane speaks to: GitHub and Google, each over the
 * OAuth 2 authorization-code flow with PKCE. A provider is on when the
 * instance has its client id and secret (see docs/self-hosting.md), so a
 * self-hosted instance shows only what its owner set up.
 *
 * Each provider turns an access token into a profile with a stable subject
 * and, when the provider vouches for it, a verified email: Drawpane links a
 * provider account to an existing account only by a verified address.
 */
import type { Env } from "../env";

export type ProviderId = "github" | "google";
export const PROVIDER_IDS: readonly ProviderId[] = ["github", "google"];

export interface Profile {
  /** The provider's stable id for the account. */
  readonly subject: string;
  /** A verified email address, or null when the provider has none to vouch for. */
  readonly email: string | null;
  readonly name: string;
  /** How the account reads in settings: "@ana" on GitHub, the address on Google. */
  readonly label: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scope: string;
  /** Extra authorize parameters (Google's account chooser). */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  readonly clientId: string;
  readonly clientSecret: string;
  profile(accessToken: string): Promise<Profile>;
}

class ProviderError extends Error {}

export { ProviderError };

const USER_AGENT = "Drawpane";

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new ProviderError(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}
interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GoogleUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** The providers this instance has credentials for. */
export function providers(env: Env): Provider[] {
  const out: Provider[] = [];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
    out.push({
      id: "github",
      name: "GitHub",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scope: "read:user user:email",
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      async profile(token) {
        const user = await getJson<GitHubUser>("https://api.github.com/user", token);
        const emails = await getJson<GitHubEmail[]>("https://api.github.com/user/emails", token);
        // The primary address if GitHub has verified it, else any verified one.
        const verified =
          emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        return {
          subject: String(user.id),
          email: verified?.email ?? null,
          name: (user.name ?? user.login).slice(0, 80),
          label: `@${user.login}`,
        };
      },
    });
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    out.push({
      id: "google",
      name: "Google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email profile",
      authorizeParams: { prompt: "select_account" },
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      async profile(token) {
        const user = await getJson<GoogleUser>(
          "https://openidconnect.googleapis.com/v1/userinfo",
          token,
        );
        const email = user.email && user.email_verified === true ? user.email : null;
        return {
          subject: user.sub,
          email,
          name: (user.name ?? user.email ?? "Google user").slice(0, 80),
          label: user.email ?? "Google account",
        };
      },
    });
  return out;
}

export function provider(env: Env, id: string): Provider | null {
  return providers(env).find((p) => p.id === id) ?? null;
}

/** Trades the authorization code for an access token. */
export async function exchangeCode(
  p: Provider,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<string> {
  const response = await fetch(p.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: verifier,
    }),
  });
  const data = (await response.json().catch(() => null)) as { access_token?: string } | null;
  if (!response.ok || !data?.access_token)
    throw new ProviderError(`${p.name} didn't accept the sign-in code.`);
  return data.access_token;
}
