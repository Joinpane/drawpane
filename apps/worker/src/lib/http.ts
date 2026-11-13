import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

/** An error with a status and a sentence a person can act on. Rendered as `{ error: { code, message } }`. */
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const unauthorized = (message = "Sign in to continue.") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You don't have access to this.") =>
  new HttpError(403, "forbidden", message);
export const notFound = (message = "That doesn't exist, or it was deleted.") =>
  new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
