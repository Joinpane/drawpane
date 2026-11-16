/**
 * SHA-256 (FIPS 180-4), synchronous, over a string's UTF-8 bytes. Web Crypto's
 * digest is asynchronous, and copy ids (decision 0029) are derived while a
 * document is read, so the model carries its own. Checked against Node's
 * `crypto` in the tests.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const W = new Uint32Array(64);
/** Reused for the message and its padding (grown when a longer one comes). */
let buffer = new Uint8Array(256);

/** Writes `text` as UTF-8 into `buffer` (without `TextEncoder`, so the package needs no DOM or Node types). */
function utf8(text: string): number {
  // At most 3 bytes a UTF-16 unit, plus padding.
  if (buffer.length < text.length * 3 + 72) buffer = new Uint8Array(text.length * 3 + 72);
  const out = buffer;
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out[at++] = code;
    else if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 63);
    } else if (code < 0x10000) {
      out[at++] = 0xe0 | (code >> 12);
      out[at++] = 0x80 | ((code >> 6) & 63);
      out[at++] = 0x80 | (code & 63);
    } else {
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 63);
      out[at++] = 0x80 | ((code >> 6) & 63);
      out[at++] = 0x80 | (code & 63);
    }
  }
  return at;
}

/** The SHA-256 digest of `text` (UTF-8), 32 bytes. */
export function sha256(text: string): Uint8Array {
  const length = utf8(text);
  const m = buffer;
  // Message, a 1 bit, zeros, then the length in bits as 64-bit big endian.
  const end = Math.ceil((length + 9) / 64) * 64;
  m[length] = 0x80;
  m.fill(0, length + 1, end - 8);
  const bits = length * 8;
  const high = Math.floor(bits / 0x100000000);
  const low = bits >>> 0;
  m[end - 8] = high >>> 24;
  m[end - 7] = (high >>> 16) & 255;
  m[end - 6] = (high >>> 8) & 255;
  m[end - 5] = high & 255;
  m[end - 4] = low >>> 24;
  m[end - 3] = (low >>> 16) & 255;
  m[end - 2] = (low >>> 8) & 255;
  m[end - 1] = low & 255;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < end; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      W[i] =
        (((m[j] as number) << 24) |
          ((m[j + 1] as number) << 16) |
          ((m[j + 2] as number) << 8) |
          (m[j + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15] as number;
      const b = W[i - 2] as number;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = ((W[i - 16] as number) + s0 + (W[i - 7] as number) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (K[i] as number) + (W[i] as number)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    const word = words[i] as number;
    out[i * 4] = word >>> 24;
    out[i * 4 + 1] = (word >>> 16) & 255;
    out[i * 4 + 2] = (word >>> 8) & 255;
    out[i * 4 + 3] = word & 255;
  }
  return out;
}
