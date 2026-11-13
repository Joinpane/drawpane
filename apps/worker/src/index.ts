import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { requireFileRole } from "./api/access";
import { api } from "./api/routes";
import { resolveShareToken } from "./api/share";
import { passkeys, publicOrigins } from "./auth/passkeys";
import { requireUser, session } from "./auth/session";
import type { AppContext } from "./env";
import { signPayload } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { sameOrigin } from "./lib/same-origin";
import { CLAIM_HEADER, type RoomClaim } from "./rooms/file-room";

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
app.route("/api/auth", passkeys);
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

export default app satisfies ExportedHandler<AppContext["Bindings"]>;
