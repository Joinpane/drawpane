import { createMiddleware } from "hono/factory";
import type { AppContext } from "../env";
import { forbidden } from "./http";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses state-changing requests from other sites. Browsers send `Origin` on
 * every cross-origin and every non-GET request, and `Sec-Fetch-Site` on all
 * modern ones; requests with neither come from non-browser clients, which
 * CSRF can't drive.
 */
export const sameOrigin = createMiddleware<AppContext>(async (c, next) => {
  if (!SAFE.has(c.req.method)) {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const host = new URL(c.req.url).host;
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      throw forbidden("Cross-site requests aren't allowed.");
    }
    if (
      (originHost !== null && originHost !== host) ||
      (site !== undefined && site !== "same-origin" && site !== "none")
    ) {
      throw forbidden("Cross-site requests aren't allowed.");
    }
  }
  await next();
});
