/**
 * The most linear memory each WebAssembly module may grow to (decision
 * 0033, item 4.2), written into the module's own memory section: resvg and
 * HarfBuzz define their memory rather than import it, so its `maximum` is
 * the only cap a host can set. Past it, an allocation fails (resvg traps,
 * HarfBuzz's `malloc` answers 0) instead of growing the isolate.
 *
 * The caps fit inside a Worker's 128 MB together with what else is held
 * there at once (decision 0033, answer 2): a 17 MB baseline, the headless
 * editor's 48 MiB meter, and these two, 127.1 MB in all.
 *
 * - HarfBuzz, 32 MiB: text in every language must measure. Font files are
 *   copied into it whole, one copy per file (`harfbuzz-faces.ts`), and CJK
 *   files are large. Measured with harfbuzzjs 1.6.4 on Google's variable
 *   files: Noto Sans SC (17.7 MB) holds 20.5 MiB, KR (10.4 MB) 12.1 MiB,
 *   TC (11.9 MB) 13.8 MiB, JP (9.5 MB) 11.1 MiB, Inter 0.6 MiB. A file in
 *   SC at four weights and Inter at three holds 24.6 MiB; SC with JP or KR
 *   as well, 31 to 32 MiB, which fits; SC with TC doesn't.
 * - resvg, 25 MiB: what's left. It holds a render's font files too (a
 *   static Noto Sans SC weight is 10.1 MiB), its images and its pixels. A
 *   2048 × 2048 picture took 34 MiB flat and 107 MiB with a shadow, so
 *   large pictures are drawn smaller to fit (`headless-render.ts`), down to
 *   256 px on their longest side.
 *
 * A Worker can't compile WebAssembly at run time, so its modules are
 * rewritten at build time (`apps/worker/scripts/cap-wasm.ts`); Node
 * rewrites the bytes as it loads them.
 */

/** resvg's cap, in bytes. */
export const RESVG_MAX_BYTES = 25 << 20;
/** HarfBuzz's cap, in bytes. */
export const HARFBUZZ_MAX_BYTES = 32 << 20;

/** WebAssembly pages are 64 KiB. */
const PAGE = 1 << 16;

export interface MemoryLimits {
  /** Pages it starts with. */
  readonly min: number;
  /** The most pages it may grow to; absent when it may grow to all wasm32 allows (4 GiB). */
  readonly max?: number;
}

function uleb(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = bytes[at++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, at];
}

function encode(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const MEMORY_SECTION = 5;

function checkModule(bytes: Uint8Array): void {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b))
    throw new Error("Not a WebAssembly module.");
}

/** The module's own memory limits, or null when it defines none (it imports its memory). */
export function memoryLimits(bytes: Uint8Array): MemoryLimits | null {
  checkModule(bytes);
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    let size: number;
    [size, at] = uleb(bytes, at);
    if (id === MEMORY_SECTION) {
      const [count, flagAt] = uleb(bytes, at);
      if (count !== 1) throw new Error("One memory expected.");
      const flag = bytes[flagAt] ?? 0;
      const [min, maxAt] = uleb(bytes, flagAt + 1);
      if (!(flag & 1)) return { min };
      const [max] = uleb(bytes, maxAt);
      return { min, max };
    }
    at += size;
  }
  return null;
}

/**
 * The module with its memory's maximum set to `maxBytes` (rounded down to
 * whole pages, and never under what it starts with). Every other section is
 * kept byte for byte.
 */
export function withMemoryMaximum(bytes: Uint8Array, maxBytes: number): Uint8Array {
  checkModule(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let found = false;
  let at = 8;
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++];
    let size: number;
    [size, at] = uleb(bytes, at);
    const body = at;
    at += size;
    if (id !== MEMORY_SECTION) {
      parts.push(bytes.subarray(start, at));
      continue;
    }
    const [count, flagAt] = uleb(bytes, body);
    if (count !== 1) throw new Error("One memory expected.");
    const flag = bytes[flagAt] ?? 0;
    // Shared or 64-bit memories have other encodings: not what these modules have.
    if (flag & ~1) throw new Error(`Unexpected memory flags ${flag}.`);
    const [min] = uleb(bytes, flagAt + 1);
    const max = Math.max(min, Math.floor(maxBytes / PAGE));
    const content = [...encode(1), 0x01, ...encode(min), ...encode(max)];
    parts.push(Uint8Array.from([MEMORY_SECTION, ...encode(content.length), ...content]));
    found = true;
  }
  if (!found) throw new Error("The module defines no memory of its own.");
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
