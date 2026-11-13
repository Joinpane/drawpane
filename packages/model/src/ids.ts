const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Largest multiple of 62 below 256, so every accepted byte maps to a digit without bias. */
const LIMIT = 248;

/** Ids are 1–64 characters from `[0-9A-Za-z_-]`, so imported ids (UUIDs) fit too. */
export const ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

/** The virtual root. Pages are its children; it is never stored. */
export const ROOT_ID = "root";

/**
 * A random base-62 id. The default 16 characters carry about 95 bits of
 * entropy, so ids can be minted on any client without coordination.
 */
export function newId(length = 16): string {
  let out = "";
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < LIMIT) {
        out += ALPHABET.charAt(byte % 62);
        if (out.length === length) break;
      }
    }
  }
  return out;
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id) && id !== ROOT_ID;
}
