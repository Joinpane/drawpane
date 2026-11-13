/**
 * Fractional order keys: strings that sort siblings and allow inserting a new
 * key between any two existing ones without renumbering.
 *
 * The scheme follows David Greenspan's "Implementing Fractional Indexing":
 * a key is a variable-length integer part (its first character encodes the
 * length) followed by an optional fraction. Keys compare with plain string
 * comparison because the base-62 digit alphabet is in ASCII order.
 */

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0] as string;
const LAST = DIGITS[DIGITS.length - 1] as string;
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

/** Longest key we accept from a client. Keys only grow under adversarial insert patterns. */
export const MAX_ORDER_KEY_LENGTH = 128;

export class OrderKeyError extends Error {
  override name = "OrderKeyError";
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new OrderKeyError(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key.charAt(0));
  if (length > key.length) throw new OrderKeyError(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function isDigit(char: string): boolean {
  return DIGITS.includes(char);
}

/** True when `key` is a well-formed order key. */
export function isValidOrderKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_ORDER_KEY_LENGTH) return false;
  if (key === SMALLEST_INTEGER) return false;
  for (const char of key.slice(1)) if (!isDigit(char)) return false;
  try {
    const int = integerPart(key);
    const fraction = key.slice(int.length);
    return !fraction.endsWith(ZERO);
  } catch {
    return false;
  }
}

function assertValid(key: string): void {
  if (!isValidOrderKey(key)) throw new OrderKeyError(`invalid order key: ${key}`);
}

/** Midpoint of two fractions, where `b` may be null (meaning "1"). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || b?.endsWith(ZERO)) throw new OrderKeyError("trailing zero");
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i] as string) + 1;
    if (d === DIGITS.length) {
      digits[i] = ZERO;
    } else {
      digits[i] = DIGITS.charAt(d);
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(ZERO);
  else digits.pop();
  return next + digits.join("");
}

function decrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i] as string) - 1;
    if (d === -1) {
      digits[i] = LAST;
    } else {
      digits[i] = DIGITS.charAt(d);
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${LAST}`;
  if (head === "A") return null;
  const prev = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prev < "Z") digits.push(LAST);
  else digits.pop();
  return prev + digits.join("");
}

/**
 * A key strictly between `a` and `b`. Pass null for an open end:
 * `keyBetween(null, null)` is the first key, `keyBetween(last, null)` appends.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertValid(a);
  if (b !== null) assertValid(b);
  if (a !== null && b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new OrderKeyError("cannot decrement any more");
    return res;
  }

  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new OrderKeyError("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** `n` evenly spread keys between `a` and `b`, in order. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n === 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    let c = keyBetween(a, b);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(c, b);
      result.push(c);
    }
    return result;
  }
  if (a === null) {
    let c = keyBetween(a, b);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(a, c);
      result.push(c);
    }
    return result.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/** Sort comparator for siblings: by key, then by id so concurrent equal keys stay stable. */
export function compareSiblings(
  a: { readonly key: string; readonly id: string },
  b: { readonly key: string; readonly id: string },
): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
