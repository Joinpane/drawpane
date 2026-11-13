/**
 * A software passkey for tests: creates an ES256 credential with "none"
 * attestation and signs assertions, so the real WebAuthn verification code
 * runs end to end.
 */
import { base64UrlToBytes, bytesToBase64Url } from "../src/lib/crypto";

type CborValue =
  | number
  | string
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | { [k: string]: CborValue };

function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  if (length < 65536) return [(major << 5) | 25, length >> 8, length & 255];
  return [
    (major << 5) | 26,
    (length >>> 24) & 255,
    (length >> 16) & 255,
    (length >> 8) & 255,
    length & 255,
  ];
}

function cbor(value: CborValue): number[] {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let out = bytes.slice(i);
    if ((out[0] as number) & 0x80) out = new Uint8Array([0, ...out]);
    return [0x02, out.length, ...out];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class SoftPasskey {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  #keys: CryptoKeyPair | null = null;
  #userHandle: string | null = null;
  #counter = 0;

  constructor(readonly origin: string) {}

  get id(): string {
    return bytesToBase64Url(this.credentialId);
  }

  async create(options: { challenge: string; rp: { id?: string }; user: { id: string } }) {
    this.#keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    this.#userHandle = options.user.id;
    const jwk = (await crypto.subtle.exportKey("jwk", this.#keys.publicKey)) as JsonWebKey;
    const cose = new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, base64UrlToBytes(jwk.x as string)],
      [-3, base64UrlToBytes(jwk.y as string)],
    ]);
    const rpIdHash = await sha256(
      new TextEncoder().encode(options.rp.id ?? new URL(this.origin).hostname),
    );
    const authData = concat(
      rpIdHash,
      new Uint8Array([0x45, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      new Uint8Array(cbor(cose)),
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToBase64Url(clientData),
        attestationObject: bytesToBase64Url(
          new Uint8Array(cbor({ fmt: "none", attStmt: {}, authData })),
        ),
        transports: ["internal"],
      },
    };
  }

  async get(options: { challenge: string; rpId?: string }) {
    if (!this.#keys) throw new Error("create the passkey first");
    this.#counter++;
    const rpIdHash = await sha256(
      new TextEncoder().encode(options.rpId ?? new URL(this.origin).hostname),
    );
    const authData = concat(
      rpIdHash,
      new Uint8Array([0x05, 0, 0, (this.#counter >> 8) & 255, this.#counter & 255]),
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.#keys.privateKey, signed),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToBase64Url(clientData),
        authenticatorData: bytesToBase64Url(authData),
        signature: bytesToBase64Url(derSignature(raw)),
        userHandle: this.#userHandle,
      },
    };
  }
}
