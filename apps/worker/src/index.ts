import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { provideHarfBuzzMeasurer } from "./agent/harfbuzz";
import { requireFileRole } from "./api/access";
import { admin } from "./api/admin";
import { email } from "./api/email";
import { api } from "./api/routes";
import { resolveShareToken } from "./api/share";
import { account } from "./auth/account";
import { oauth } from "./auth/oauth";
import { passkeys, publicOrigins } from "./auth/passkeys";
import { requireUser, session } from "./auth/session";
import { tokens } from "./auth/tokens";
import { sendNotificationEmails } from "./email/notify";
import type { AppContext } from "./env";
import { signPayload, verifyPayload } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { sameOrigin } from "./lib/same-origin";
import { mcp } from "./mcp/server";
import { CLAIM_HEADER, type DocumentTicket, type RoomClaim } from "./rooms/file-room";
import { snapshotKey } from "./rooms/snapshots";

export { FileRoom } from "./rooms/file-room";

/** How long the claim the Worker hands a FileRoom stays valid; it is used once, at upgrade. */
const CLAIM_TTL_MS = 60_000;

const app = new Hono<AppContext>();

app.use("/api/*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
// Unsafe methods must come from this origin. Browsers already preflight
// cross-origin JSON, so this is defence in depth against CSRF.
app.use("/api/*", sameOrigin);
app.use("/api/*", session);
app.use("/ws/*", session);

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth/oauth", oauth);
app.route("/api/auth", passkeys);
// Personal access tokens (decision 0011), before the rest of the account.
app.route("/api/account/tokens", tokens);
app.route("/api/account", account);
app.route("/api/admin", admin);
app.route("/api/email", email);
// The MCP server (decision 0011): bearer tokens, not the session.
app.route("/api/mcp", mcp);
/**
 * A file too large to send through its room's socket, downloaded with the
 * ticket the room gave in its welcome (protocol mode `download`): the room
 * already let this person in, so the ticket is all it takes. It's version 2
 * snapshot text, gzipped and streamed as read: a saved version from R2 (the
 * room sends the transactions after it through the socket), or the file as
 * it is now, copied aside in the room (also when that version is missing),
 * one copy for everyone downloading that revision. Access is checked again:
 * the ticket says who it was given to.
 */
app.get("/api/files/:fileId/document", async (c) => {
  const ticket = await verifyPayload<DocumentTicket>(
    c.env.SESSION_SECRET,
    c.req.query("ticket") ?? "",
  );
  if (
    ticket?.purpose !== "document" ||
    ticket.fid !== c.req.param("fileId") ||
    typeof ticket.uid !== "string" ||
    !(ticket.exp > Date.now())
  )
    throw new HttpError(403, "forbidden", "That download has expired. Open the file again.");
  // Whoever it was given to must still have the file: on its team, or its prototype link still on.
  const guestLink = ticket.uid.startsWith("guest:") ? ticket.uid.slice("guest:".length) : null;
  const file =
    guestLink === null
      ? (await requireFileRole(c.env, ticket.uid, ticket.fid, "viewer")).file
      : await c.env.DB.prepare(
          `SELECT f.deleted_at FROM share_links s JOIN files f ON f.id = s.file_id
            WHERE s.id = ? AND s.file_id = ? AND s.revoked_at IS NULL`,
        )
          .bind(guestLink, ticket.fid)
          .first<{ deleted_at: number | null }>();
  if (!file) throw new HttpError(403, "forbidden", "This prototype link was turned off.");
  if (file.deleted_at !== null) throw new HttpError(404, "not_found", "This file was deleted.");
  const gzip = (body: ReadableStream<Uint8Array>, size?: number) =>
    new Response(body, {
      headers: {
        "content-type": "application/x-ndjson",
        "content-encoding": "gzip",
        ...(size === undefined ? {} : { "content-length": String(size) }),
        "cache-control": "private, no-store",
      },
      // Gzip already: not compressed again.
      encodeBody: "manual",
    });
  if (typeof ticket.revn === "number") {
    const object = await c.env.FILES.get(snapshotKey(ticket.fid, ticket.revn));
    const revn = object?.customMetadata?.revn;
    if (object && (revn === undefined || revn === String(ticket.revn)))
      return gzip(object.body, object.size);
    await object?.body.cancel();
  }
  const room = c.env.FILE_ROOM.get(c.env.FILE_ROOM.idFromName(ticket.fid));
  const document = await room.exportDocument();
  if (!document)
    throw new HttpError(
      503,
      "rate_limited",
      "Many people are opening this file. Trying again shortly.",
    );
  return gzip(document);
});

app.route("/api", api);

app.get("/ws/files/:fileId", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "bad_request", "Expected a websocket upgrade.");
  }
  const origin = c.req.header("origin");
  if (origin && !publicOrigins(c).includes(origin)) {
    throw new HttpError(403, "forbidden", "Cross-origin websockets aren't allowed.");
  }
  const user = requireUser(c);
  const { file, role } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
  const claim: RoomClaim = {
    uid: user.id,
    name: user.name,
    fid: file.id,
    role,
    kind: "person",
    exp: Date.now() + CLAIM_TTL_MS,
  };
  const headers = new Headers(c.req.raw.headers);
  headers.set(CLAIM_HEADER, await signPayload(c.env.SESSION_SECRET, claim));
  const room = c.env.FILE_ROOM.get(c.env.FILE_ROOM.idFromName(file.id));
  return room.fetch(new Request(c.req.raw.url, { headers }));
});

/**
 * A guest playing a shared prototype: read-only, anonymous, and the room
 * tells them nothing about the people in the file.
 */
app.get("/ws/share/:token", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "bad_request", "Expected a websocket upgrade.");
  }
  const origin = c.req.header("origin");
  if (origin && !publicOrigins(c).includes(origin)) {
    throw new HttpError(403, "forbidden", "Cross-origin websockets aren't allowed.");
  }
  const shared = await resolveShareToken(c.env, c.req.param("token"));
  if (!shared) throw new HttpError(404, "not_found", "This prototype link was turned off.");
  const claim: RoomClaim = {
    uid: `guest:${shared.linkId}`,
    name: "Guest",
    fid: shared.file.id,
    role: "viewer",
    kind: "person",
    guest: true,
    exp: Date.now() + CLAIM_TTL_MS,
  };
  const headers = new Headers(c.req.raw.headers);
  headers.set(CLAIM_HEADER, await signPayload(c.env.SESSION_SECRET, claim));
  const room = c.env.FILE_ROOM.get(c.env.FILE_ROOM.idFromName(shared.file.id));
  return room.fetch(new Request(c.req.raw.url, { headers }));
});

app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
    return c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404);
  }
  // Anything else belongs to the app; the assets binding serves index.html for client routes.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof ZodError) {
    return c.json(
      { error: { code: "bad_request", message: error.issues[0]?.message ?? "Invalid request." } },
      400,
    );
  }
  console.error(error);
  return c.json(
    { error: { code: "internal", message: "Something went wrong on our side. Try again." } },
    500,
  );
});

// Agents design here: their text is measured as the browser measures it (decision 0021).
provideHarfBuzzMeasurer();

export default {
  fetch: app.fetch,
  /** Every few minutes (wrangler.jsonc triggers): emails about the inbox, when email is on. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sendNotificationEmails(env).then(() => undefined));
  },
} satisfies ExportedHandler<AppContext["Bindings"]>;
