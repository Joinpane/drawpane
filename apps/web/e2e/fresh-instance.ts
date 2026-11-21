/**
 * A throwaway Drawpane instance for one spec file: its own Worker, port and
 * database, set up with a passkey owner. Specs that need a signed-in owner
 * use this instead of the shared server, whose setup editor.spec.ts claims.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { engineCiStorage } from "./engine-ci-storage";

export interface Instance {
  readonly url: string;
  readonly context: BrowserContext;
  readonly page: Page;
  stop(): Promise<void>;
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The test Worker exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The test Worker at ${url} didn't start in time.`);
}

/** A test Worker of its own: an un-set-up instance with a throwaway database. */
export interface TestWorker {
  readonly url: string;
  stop(): Promise<void>;
}

/** Starts a Worker on `port` (and its inspector on `inspectorPort`) and waits until it answers. */
export async function startWorker({
  port,
  inspectorPort,
  env = {},
}: {
  port: number;
  inspectorPort: number;
  /** More for server.mjs, e.g. `E2E_KIT_REGISTRY`. */
  env?: Record<string, string>;
}): Promise<TestWorker> {
  const url = `http://localhost:${port}`;
  // Something already answering there is no fresh instance: most often a Worker left
  // behind by an interrupted run, already set up. Say so rather than test against it.
  if (await answers(url))
    throw new Error(
      `Port ${port} is already serving: a test Worker left by an interrupted run? Stop it and try again.`,
    );
  const child = spawn("node", [resolve(import.meta.dirname, "server.mjs")], {
    env: {
      ...process.env,
      ...env,
      E2E_PORT: String(port),
      E2E_INSPECTOR_PORT: String(inspectorPort),
    },
    stdio: "inherit",
    detached: true,
  });
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    // The whole group: wrangler starts workerd, which would otherwise keep the port.
    process.kill(-child.pid, "SIGTERM");
    await new Promise((r) => child.once("exit", r));
  };
  try {
    await waitForHealth(url, child, 120_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop };
}

/**
 * Ephemeral local HTTPS reverse proxy to `http://127.0.0.1:${targetPort}` (HTTP + WebSocket).
 * Used for WebKit on Linux where `Secure` (`__Host-`) cookies are not sent over plain HTTP localhost.
 */
async function startHttpsProxy(targetPort: number): Promise<{
  readonly url: string;
  stop(): Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "drawpane-e2e-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const gen = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (gen.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`openssl self-signed cert failed: ${gen.stderr?.toString() ?? ""}`);
  }
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  rmSync(dir, { recursive: true, force: true });

  const server: HttpsServer = createHttpsServer({ key, cert }, (req, res) => {
    // Wrangler dev validates the Host header against `--local-upstream localhost:${targetPort}`;
    // keep Origin intact so `PUBLIC_ORIGIN` (the HTTPS proxy origin) passes same-origin & WebAuthn.
    const headers = { ...req.headers, host: `localhost:${targetPort}` };
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const upstream = netConnect(targetPort, "127.0.0.1", () => {
      const headers = { ...req.headers, host: `localhost:${targetPort}` };
      const rawHeaders = Object.entries(headers)
        .flatMap(([k, v]) =>
          Array.isArray(v)
            ? v.map((item) => `${k}: ${item}`)
            : v !== undefined
              ? [`${k}: ${v}`]
              : [],
        )
        .join("\r\n");
      upstream.write(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n${rawHeaders}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTPS proxy failed to bind");
  return {
    url: `https://localhost:${address.port}`,
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * Pure WebCrypto ECDSA P-256 virtual passkey authenticator for Firefox and WebKit,
 * where Playwright's Chromium-only CDP WebAuthn domain is unavailable.
 * Credentials are stored in Node scoped to the `BrowserContext` so they persist across
 * full reloads, navigations, and sign-outs while enforcing `rpId` and `allowCredentials`.
 */
interface SerializedPasskey {
  id: string;
  rawIdB64: string;
  rpId: string;
  userHandleB64: string;
  privateJwk: JsonWebKey;
  signCount: number;
}

async function installWebCryptoPasskey(context: BrowserContext): Promise<void> {
  const store: SerializedPasskey[] = [];
  await context.exposeBinding("__drawpanePasskeySave", (_source, cred: SerializedPasskey) => {
    store.push(cred);
  });
  await context.exposeBinding(
    "__drawpanePasskeyFind",
    (_source, query: { rpId: string; allow: string[] }): SerializedPasskey | null => {
      const cred =
        query.allow.length > 0
          ? store.find((c) => c.rpId === query.rpId && query.allow.includes(c.id))
          : store.findLast((c) => c.rpId === query.rpId);
      if (!cred) return null;
      cred.signCount += 1;
      return { ...cred };
    },
  );

  await context.addInitScript(() => {
    const encoder = new TextEncoder();
    const toBytes = (buf: BufferSource): Uint8Array =>
      buf instanceof Uint8Array
        ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : ArrayBuffer.isView(buf)
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : new Uint8Array(buf);
    const concat = (...parts: Uint8Array[]): Uint8Array => {
      const len = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(len);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    const b64u = (bytes: Uint8Array): string => {
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };
    const fromB64u = (str: string): Uint8Array => {
      const pad = "=".repeat((4 - (str.length % 4)) % 4);
      const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    const cborBytes = (bytes: Uint8Array): Uint8Array => {
      const n = bytes.length;
      if (n < 24) return concat(new Uint8Array([0x40 | n]), bytes);
      if (n < 256) return concat(new Uint8Array([0x58, n]), bytes);
      return concat(new Uint8Array([0x59, (n >> 8) & 0xff, n & 0xff]), bytes);
    };
    const cborText = (s: string): Uint8Array => {
      const b = encoder.encode(s);
      const n = b.length;
      if (n < 24) return concat(new Uint8Array([0x60 | n]), b);
      return concat(new Uint8Array([0x78, n]), b);
    };
    const derInt = (raw: Uint8Array): Uint8Array => {
      let start = 0;
      while (start < raw.length - 1 && raw[start] === 0) start++;
      const trimmed = raw.subarray(start);
      const prefixed = (trimmed[0] ?? 0) >= 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;
      return concat(new Uint8Array([0x02, prefixed.length]), prefixed);
    };
    const p1363ToDer = (sig: Uint8Array): Uint8Array => {
      const r = derInt(sig.subarray(0, 32));
      const s = derInt(sig.subarray(32, 64));
      return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
    };

    type Bridge = {
      __drawpanePasskeySave(cred: SerializedPasskey): Promise<void>;
      __drawpanePasskeyFind(query: {
        rpId: string;
        allow: string[];
      }): Promise<SerializedPasskey | null>;
    };

    const create = async (options?: CredentialCreationOptions): Promise<Credential | null> => {
      const pk = options?.publicKey;
      if (!pk) return null;
      const rpId = pk.rp?.id ?? window.location.hostname;
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
      const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
      const x = fromB64u(jwk.x as string);
      const y = fromB64u(jwk.y as string);
      // COSE EC2 P-256 public key: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
      const coseKey = concat(
        new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
        cborBytes(x),
        new Uint8Array([0x22]),
        cborBytes(y),
      );
      const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
      const credId = crypto.getRandomValues(new Uint8Array(16));
      const flags = new Uint8Array([0x45]); // UP | UV | AT
      const signCount = new Uint8Array([0, 0, 0, 0]);
      const aaguid = new Uint8Array(16);
      const credIdLen = new Uint8Array([(credId.length >> 8) & 0xff, credId.length & 0xff]);
      const authData = concat(rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey);
      // CBOR map {"fmt": "none", "attStmt": {}, "authData": authData}
      const attestationObject = concat(
        new Uint8Array([0xa3]),
        cborText("fmt"),
        cborText("none"),
        cborText("attStmt"),
        new Uint8Array([0xa0]),
        cborText("authData"),
        cborBytes(authData),
      );
      const clientDataBytes = encoder.encode(
        JSON.stringify({
          type: "webauthn.create",
          challenge: b64u(toBytes(pk.challenge)),
          origin: window.location.origin,
          crossOrigin: false,
        }),
      );
      const id = b64u(credId);
      const userHandle = toBytes(pk.user.id);
      await (window as unknown as Bridge).__drawpanePasskeySave({
        id,
        rawIdB64: b64u(credId),
        rpId,
        userHandleB64: b64u(userHandle),
        privateJwk,
        signCount: 0,
      });
      return {
        id,
        rawId: credId.buffer.slice(credId.byteOffset, credId.byteOffset + credId.byteLength),
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: clientDataBytes.buffer.slice(
            clientDataBytes.byteOffset,
            clientDataBytes.byteOffset + clientDataBytes.byteLength,
          ),
          attestationObject: attestationObject.buffer.slice(
            attestationObject.byteOffset,
            attestationObject.byteOffset + attestationObject.byteLength,
          ),
          getTransports: () => ["internal"],
          getAuthenticatorData: () =>
            authData.buffer.slice(authData.byteOffset, authData.byteOffset + authData.byteLength),
          getPublicKey: () => spki,
          getPublicKeyAlgorithm: () => -7,
        },
      } as unknown as Credential;
    };

    const get = async (options?: CredentialRequestOptions): Promise<Credential | null> => {
      const pk = options?.publicKey;
      if (!pk) return null;
      const rpId = pk.rpId ?? window.location.hostname;
      const allow = (pk.allowCredentials ?? []).map((c) => b64u(toBytes(c.id)));
      const cred = await (window as unknown as Bridge).__drawpanePasskeyFind({ rpId, allow });
      if (!cred) throw new DOMException("No matching passkey registered", "NotAllowedError");
      const rawId = fromB64u(cred.rawIdB64);
      const userHandle = fromB64u(cred.userHandleB64);
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        cred.privateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
      const flags = new Uint8Array([0x05]); // UP | UV
      const count = new Uint8Array(4);
      new DataView(count.buffer).setUint32(0, cred.signCount, false);
      const authData = concat(rpIdHash, flags, count);
      const clientDataBytes = encoder.encode(
        JSON.stringify({
          type: "webauthn.get",
          challenge: b64u(toBytes(pk.challenge)),
          origin: window.location.origin,
          crossOrigin: false,
        }),
      );
      const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
      const rawSig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          privateKey,
          concat(authData, clientHash) as BufferSource,
        ),
      );
      const derSig = p1363ToDer(rawSig);
      return {
        id: cred.id,
        rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength),
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: clientDataBytes.buffer.slice(
            clientDataBytes.byteOffset,
            clientDataBytes.byteOffset + clientDataBytes.byteLength,
          ),
          authenticatorData: authData.buffer.slice(
            authData.byteOffset,
            authData.byteOffset + authData.byteLength,
          ),
          signature: derSig.buffer.slice(derSig.byteOffset, derSig.byteOffset + derSig.byteLength),
          userHandle: userHandle.buffer.slice(
            userHandle.byteOffset,
            userHandle.byteOffset + userHandle.byteLength,
          ),
        },
      } as unknown as Credential;
    };

    const container = { create, get };
    try {
      Object.defineProperty(navigator, "credentials", {
        value: container,
        configurable: true,
      });
    } catch {
      const existing = navigator.credentials as unknown as {
        create: typeof create;
        get: typeof get;
      };
      existing.create = create;
      existing.get = get;
    }
    if (typeof window.PublicKeyCredential === "undefined") {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: {
          isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
          isConditionalMediationAvailable: async () => false,
        },
        configurable: true,
      });
    }
  });
}

/** A virtual passkey for this page's browser context, so sign-up and sign-in need no device. */
export async function addPasskey(context: BrowserContext, page: Page): Promise<void> {
  if (context.browser()?.browserType().name() === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return;
  }
  await installWebCryptoPasskey(context);
}

/** Starts a Worker on `port` and signs a new owner in with a virtual passkey. */
export async function freshInstance(
  browser: Browser,
  ports: { port: number; inspectorPort: number; env?: Record<string, string> },
): Promise<Instance> {
  const isWebkit = browser.browserType().name() === "webkit";
  const proxy = isWebkit ? await startHttpsProxy(ports.port) : null;
  const workerEnv = proxy ? { ...ports.env, E2E_PUBLIC_ORIGIN: proxy.url } : (ports.env ?? {});
  let worker: TestWorker;
  try {
    worker = await startWorker({ ...ports, env: workerEnv });
  } catch (error) {
    await proxy?.stop();
    throw error;
  }
  const url = proxy?.url ?? worker.url;
  try {
    const context = await browser.newContext({
      baseURL: url,
      ...engineCiStorage(url),
      acceptDownloads: true,
      ...(isWebkit ? { ignoreHTTPSErrors: true } : {}),
    });
    const page = await context.newPage();
    await addPasskey(context, page);
    await page.goto("/setup");
    await page.getByLabel("Your name").fill("Ana Lima");
    await page.getByLabel("Email").fill("ana@example.com");
    await page.getByLabel("Setup token").fill("e2e-setup-token");
    await page.getByRole("button", { name: "Create account with a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
    return {
      url,
      context,
      page,
      stop: async () => {
        // After a timeout the context may be gone already; the Worker must stop regardless.
        await context.close().catch(() => {});
        await worker.stop();
        await proxy?.stop();
      },
    };
  } catch (error) {
    await worker.stop();
    await proxy?.stop();
    throw error;
  }
}

/** A PNG made in the page, as a File dropped onto the canvas at a screen point. */
export async function dropImage(
  page: Page,
  at: { x: number; y: number },
  image: { name: string; width: number; height: number; colors: readonly string[] },
): Promise<void> {
  await page.evaluate(
    async ({ at, image }) => {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // Vertical bands, one per colour, so placement and scale modes are visible.
      const band = image.width / image.colors.length;
      image.colors.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(Math.floor(i * band), 0, Math.ceil(band), image.height);
      });
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const data = new DataTransfer();
      data.items.add(new File([blob], image.name, { type: "image/png" }));
      const target = document.querySelector(".canvas__overlay");
      if (!target) throw new Error("no canvas");
      const init = {
        dataTransfer: data,
        clientX: at.x,
        clientY: at.y,
        bubbles: true,
        cancelable: true,
      };
      target.dispatchEvent(new DragEvent("dragenter", init));
      target.dispatchEvent(new DragEvent("dragover", init));
      target.dispatchEvent(new DragEvent("drop", init));
    },
    { at, image },
  );
}

/** The design canvas's colour at a screen point, as #rrggbb. */
export async function canvasColor(page: Page, at: { x: number; y: number }): Promise<string> {
  return page.evaluate((at) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".canvas__layer:not(.canvas__overlay)",
    );
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("no canvas");
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    const [r = 0, g = 0, b = 0] = ctx.getImageData(
      (at.x - rect.left) * k,
      (at.y - rect.top) * k,
      1,
      1,
    ).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }, at);
}
