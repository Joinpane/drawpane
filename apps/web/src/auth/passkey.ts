import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { ApiError, api, type User } from "../api/client";

/** Turns WebAuthn failures into sentences a person can act on. */
function explain(error: unknown): Error {
  if (error instanceof ApiError) return error;
  if (error instanceof WebAuthnError || error instanceof DOMException) {
    if (
      error.name === "NotAllowedError" ||
      error.name === "AbortError" ||
      ("code" in error && error.code === "ERROR_CEREMONY_ABORTED")
    ) {
      return new Error("Passkey request was cancelled. Try again when you're ready.");
    }
    if (error.name === "InvalidStateError")
      return new Error("This device already has a passkey for this account. Sign in instead.");
    if (error.name === "SecurityError")
      return new Error("Passkeys need a secure connection (https) on this address.");
  }
  return new Error(
    "Your browser couldn't create or use a passkey here. Try another browser or device.",
  );
}

export async function signInWithPasskey(): Promise<User> {
  try {
    const options =
      await api.post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
        "/auth/login/options",
      );
    const response = await startAuthentication({ optionsJSON: options });
    const { user } = await api.post<{ user: User }>("/auth/login/verify", response);
    return user;
  } catch (error) {
    throw explain(error);
  }
}

export async function registerWithPasskey(input: {
  name: string;
  email: string;
  setupToken?: string;
  inviteToken?: string;
}): Promise<User> {
  try {
    const options = await api.post<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      "/auth/register/options",
      input,
    );
    const response = await startRegistration({ optionsJSON: options });
    const { user } = await api.post<{ user: User }>("/auth/register/verify", response);
    return user;
  } catch (error) {
    throw explain(error);
  }
}

/** Adds a passkey to the signed-in account (from account settings). */
export async function addPasskey(): Promise<void> {
  try {
    const options =
      await api.post<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/auth/passkeys/options",
      );
    const response = await startRegistration({ optionsJSON: options });
    await api.post("/auth/passkeys/verify", response);
  } catch (error) {
    if (
      (error instanceof WebAuthnError || error instanceof DOMException) &&
      error.name === "InvalidStateError"
    )
      throw new Error(
        "This device already has a passkey for your account. Add one from another device or password manager.",
      );
    throw explain(error);
  }
}

export async function signOut(): Promise<void> {
  await api.post("/auth/logout");
}
