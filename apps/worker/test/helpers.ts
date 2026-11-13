import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newId } from "@drawpane/model";
import { SESSION_COOKIE } from "../src/auth/session";
import { randomToken, sha256Hex } from "../src/lib/crypto";

export const ORIGIN = "https://design.example.com";

/** A cookie jar for one simulated browser. */
export class Browser {
  readonly cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    let body: BodyInit | null = init.body ?? null;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const { json: _json, ...rest } = init;
    const response = await exports.default.fetch(
      new Request(new URL(path, ORIGIN), { ...rest, headers, body }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async json<T = Record<string, unknown>>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<T> {
    const response = await this.fetch(path, init);
    const data = (await response.json()) as T;
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
    return data;
  }
}

/** Creates a user with a team, a project and a signed-in browser, skipping passkeys. */
export async function signedInUser(
  name = "Ana Lima",
  role: "owner" | "editor" | "viewer" = "owner",
  teamId?: string,
) {
  const now = Date.now();
  const userId = newId();
  const team = teamId ?? newId();
  const projectId = newId();
  const token = randomToken();
  const statements = [
    env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(
      userId,
      `${userId}@example.com`,
      name,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(token), userId, now, now + 86_400_000),
  ];
  if (!teamId) {
    statements.push(
      env.DB.prepare("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)").bind(
        team,
        "Team",
        now,
      ),
      env.DB.prepare(
        "INSERT INTO projects (id, team_id, name, created_at, updated_at) VALUES (?, ?, 'Drafts', ?, ?)",
      ).bind(projectId, team, now, now),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).bind(team, userId, role, now),
  );
  await env.DB.batch(statements);
  const browser = new Browser();
  browser.cookies.set(SESSION_COOKIE, token);
  return { userId, teamId: team, projectId, browser };
}

/** Opens a file socket and collects messages. */
export async function openSocket(browser: Browser, fileId: string) {
  const response = await browser.fetch(`/ws/files/${fileId}`, {
    headers: { upgrade: "websocket" },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${response.status} ${await response.text()}`);
  ws.accept();
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    inbox.push(JSON.parse(event.data as string) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  /** Waits for the next message matching `t`, consuming everything before it. */
  async function next<T = Record<string, unknown>>(t: string, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex((m) => m.t === t);
      if (index !== -1) return inbox.splice(0, index + 1).at(-1) as T;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${t}; inbox: ${JSON.stringify(inbox)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  return { ws, inbox, next, send };
}
