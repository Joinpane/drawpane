/**
 * WebGL2 backend browser regression suite (review of PR #231):
 *
 * - Visible onscreen 65x17 (non-256-aligned) canvas presentation matches `gpuPixels()` readback
 *   with asymmetric content verifying orientation and opaque/translucent backgrounds.
 * - Stalled `getSyncParameter` fence during `createGpu` probe times out cleanly (`Timeout`, 12)
 *   without waiting for `webglcontextlost`, and a runtime readback timeout on a healthy context
 *   returns `Timeout` (12) while leaving `gpuCheck()` healthy and subsequent renders intact.
 * - Sibling Wasm trap + renewal while a real WebGL `attachGpu` fence is pending quiesces the
 *   trapped generation without crashing Chromium, completes the old attach as typed `Trap` (100),
 *   and lets the renewed generation attach WebGL2 and render cleanly.
 * - Disposing (`Engine.free()` / `detachGpu()`) during pending `gpuFinished()` + `gpuPixels()`
 *   cancels both waits immediately and stops WebGL sync polling (`checksAfterFree === 0`), both
 *   when freed immediately and when freed after polling has started.
 * - Concurrent `gpuFinished()` waits are bounded (`ErrorCode.State`, 11).
 * - Device `MAX_TEXTURE_SIZE` limits are validated before allocation: oversized frames and images
 *   return typed `ErrorCode.Limit` (4) without tainting `gpuCheck()`, and adapters smaller than
 *   the glyph atlas are refused at startup (`ErrorCode.NoAdapter`, 9).
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { transformWithOxc } from "vite";

const DIST = fileURLToPath(new URL("../../../packages/engine/dist", import.meta.url));
const ENGINE_SRC = fileURLToPath(new URL("../../../packages/engine/src", import.meta.url));

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

test.describe("WebGL2 backend waits, disposal, limits, and presentation", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Serves local dist/ engine modules directly.");
  let server: Server;
  let baseUrl: string;

  test.beforeAll(async () => {
    const facadeCode = (
      await transformWithOxc(await readFile(`${ENGINE_SRC}/index.ts`, "utf8"), "index.ts")
    ).code.replaceAll("./wire", "/wire.js");
    const wireCode = (
      await transformWithOxc(await readFile(`${ENGINE_SRC}/wire.ts`, "utf8"), "wire.ts")
    ).code;
    server = createServer(async (req, res) => {
      if (req.url === "/facade.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(facadeCode);
        return;
      }
      if (req.url === "/wire.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(wireCode);
        return;
      }
      const match = req.url?.match(/^\/(webgl|browser)\/(engine\.js|engine_bg\.wasm)$/);
      if (!match) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<!doctype html><title>WebGL2 regressions</title>");
        return;
      }
      try {
        const data = await readFile(`${DIST}${req.url}`);
        res.setHeader(
          "content-type",
          match[2]?.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  test("renders non-256-aligned 65x17 onscreen WebGL2 canvas matching readback", async ({
    page,
  }) => {
    await page.goto(baseUrl);
    const out = await page.evaluate(async (modUrl) => {
      const m = (await import(modUrl)) as typeof import("@drawpane/engine/webgl-glue");
      await m.default();
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const init = await m.createGpu(canvas, 0);
      if (!init.ok) return { error: init.message };
      const { backend } = init;
      const engine = new m.Engine(0, 0);
      const attached = engine.attachGpu?.(init);
      init.free();
      if (!attached?.ok) return { error: attached?.message ?? "no attachGpu" };
      attached.free();
      const w = 65;
      const h = 17;
      const displayed = document.createElement("canvas");
      displayed.width = w;
      displayed.height = h;
      const ctx = displayed.getContext("2d");
      if (!ctx) return { error: "no 2d context" };
      const colors = [];
      for (const background of [
        [0.25, 0.5, 0.75, 1],
        [0.25, 0.5, 0.75, 0.5],
      ]) {
        const r = engine.renderGpu?.(w, h, 1, 0, 0, 1, new Float32Array(background), false, 0);
        if (!r?.ok) return { error: r?.message ?? "no renderGpu" };
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0);
        const screen = Array.from(ctx.getImageData(64, 16, 1, 1).data);
        const px = await engine.gpuPixels?.();
        r.free();
        if (!(px instanceof Uint8Array)) return { error: px?.message ?? "no gpuPixels" };
        colors.push({ screen, bytes: px.length, last: Array.from(px.slice(-4)) });
      }
      engine.free();
      return { backend, colors };
    }, "/webgl/engine.js");
    expect(out.error).toBeUndefined();
    expect(out.backend).toBe("webgl2");
    expect(out.colors?.[0]?.bytes).toBe(65 * 17 * 4);
    expect(out.colors?.[0]?.screen).toEqual(out.colors?.[0]?.last);
    expect(out.colors?.[1]?.bytes).toBe(65 * 17 * 4);
    expect(out.colors?.[1]?.last?.[3]).toBeGreaterThanOrEqual(127);
    expect(out.colors?.[1]?.last?.[3]).toBeLessThanOrEqual(128);
  });

  test("times out a never-signalling WebGL2 fence during startup probe without context loss", async ({
    page,
  }) => {
    await page.goto(baseUrl);
    const probe = await page.evaluate(async (modUrl) => {
      const m = (await import(modUrl)) as typeof import("@drawpane/engine/webgl-glue");
      await m.default();
      const proto = WebGL2RenderingContext.prototype;
      const original = proto.getSyncParameter;
      let checks = 0;
      proto.getSyncParameter = function (sync, parameter) {
        if (parameter === this.SYNC_STATUS) {
          checks++;
          return this.UNSIGNALED;
        }
        return original.call(this, sync, parameter);
      };
      try {
        const probeCanvas = document.createElement("canvas");
        const t0 = performance.now();
        const init = await m.createGpu(probeCanvas, 0);
        const elapsedMs = performance.now() - t0;
        const result = { ok: init.ok, code: init.code, message: init.message };
        init.free();
        const probeContextLost = probeCanvas.getContext("webgl2")?.isContextLost() ?? true;
        const checksAtEnd = checks;
        await new Promise((r) => setTimeout(r, 250));
        return {
          result,
          elapsedMs,
          probeContextLost,
          checks: checksAtEnd,
          checksAfterEnd: checks - checksAtEnd,
        };
      } finally {
        proto.getSyncParameter = original;
      }
    }, "/webgl/engine.js");
    expect(probe.result.ok).toBe(false);
    expect(probe.result.code).toBe(12);
    expect(probe.result.message).toContain("timed out");
    expect(probe.probeContextLost).toBe(false);
    expect(probe.elapsedMs).toBeLessThan(12_000);
    expect(probe.checks).toBeGreaterThan(0);
    expect(probe.checksAfterEnd).toBe(0);
  });

  test("returns Timeout (12) for a late runtime readback while leaving the healthy WebGL2 device usable", async ({
    page,
  }) => {
    await page.goto(baseUrl);
    const out = await page.evaluate(async (modUrl) => {
      const m = (await import(modUrl)) as typeof import("@drawpane/engine/webgl-glue");
      await m.default();
      const init = await m.createGpu(document.createElement("canvas"), 0);
      if (!init.ok) throw new Error(init.message);
      const engine = new m.Engine(0, 0);
      const attached = engine.attachGpu?.(init);
      init.free();
      if (!attached?.ok) throw new Error(attached?.message ?? "no attachGpu");
      attached.free();

      const proto = WebGL2RenderingContext.prototype;
      const original = proto.getSyncParameter;
      let until = 0;
      proto.getSyncParameter = function (sync, parameter) {
        if (parameter === this.SYNC_STATUS && until > 0 && performance.now() < until) {
          return this.UNSIGNALED;
        }
        return original.call(this, sync, parameter);
      };
      try {
        until = performance.now() + 12_500;
        const r1 = engine.renderGpu?.(64, 64, 1, 0, 0, 1, new Float32Array([1, 0, 0, 1]), false, 0);
        if (!r1?.ok) throw new Error(r1?.message ?? "renderGpu failed");
        r1.free();
        const px1 = await engine.gpuPixels?.();
        const late =
          px1 instanceof Uint8Array
            ? { ok: true, code: 0, message: "" }
            : (() => {
                if (!px1) return { ok: false, code: -1, message: "missing" };
                const res = { ok: px1.ok, code: px1.code, message: px1.message };
                px1.free();
                return res;
              })();
        const check = engine.gpuCheck?.();
        const health = check
          ? (() => {
              const res = { ok: check.ok, code: check.code, message: check.message };
              check.free();
              return res;
            })()
          : null;
        await new Promise((r) => setTimeout(r, Math.max(0, until - performance.now()) + 20));
        until = 0;
        const r2 = engine.renderGpu?.(64, 64, 1, 0, 0, 1, new Float32Array([1, 0, 0, 1]), false, 0);
        const ok2 = r2?.ok ?? false;
        r2?.free();
        const px2 = await engine.gpuPixels?.();
        const pixel = px2 instanceof Uint8Array ? Array.from(px2.slice(0, 4)) : null;
        engine.free();
        return { late, health, ok2, pixel };
      } finally {
        proto.getSyncParameter = original;
      }
    }, "/webgl/engine.js");
    expect(out.late).toMatchObject({ ok: false, code: 12 });
    expect(out.late.message).toContain("timed out after 12000 ms");
    expect(out.health).toMatchObject({ ok: true, code: 0 });
    expect(out.ok2).toBe(true);
    expect(out.pixel).toEqual([255, 0, 0, 255]);
  });

  test("isolates renewed Wasm generations when a sibling traps during a pending WebGL fence", async ({
    page,
  }) => {
    const errors: string[] = [];
    let crashed = false;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("crash", () => {
      crashed = true;
    });
    await page.goto(baseUrl);
    const out = await page.evaluate(
      async ({ modUrl, wasmUrl, facadeUrl }) => {
        const m = await import(modUrl);
        const facade = await import(facadeUrl);
        const bytes = await (await fetch(wasmUrl)).arrayBuffer();
        const a = facade.loadEngineSync(m, bytes, "webgl");
        const b = facade.loadEngineSync(m, bytes, "webgl");
        const first = new facade.RenderEngine(a);
        const second = new facade.RenderEngine(b);

        const proto = WebGL2RenderingContext.prototype;
        const real = proto.getSyncParameter;
        let sawFence = false;
        let resolveFence!: () => void;
        const observed = new Promise<void>((resolve) => {
          resolveFence = resolve;
        });
        proto.getSyncParameter = function (sync, key) {
          if (key === this.SYNC_STATUS) {
            sawFence = true;
            resolveFence();
            return this.UNSIGNALED;
          }
          return real.call(this, sync, key);
        };

        const oldAttach = second.attachGpu(document.createElement("canvas"));
        await Promise.race([observed, new Promise((r) => setTimeout(r, 4000))]);
        if (!sawFence) throw new Error("startup WebGL fence was not polled");

        const oldApply = m.Engine.prototype.apply;
        m.Engine.prototype.apply = () => {
          throw new WebAssembly.RuntimeError("injected sibling trap");
        };
        const fault = first.apply(new Uint8Array(20));
        m.Engine.prototype.apply = oldApply;

        const fresh = new facade.RenderEngine(a);
        const freshDeadBeforeDispose = fresh.dead;
        // Release the fence so any unquiesced callback from generation 0 would resume now.
        proto.getSyncParameter = real;
        const oldOutcome = await Promise.race([
          oldAttach,
          new Promise((r) => setTimeout(() => r({ pending: true }), 4000)),
        ]);
        // Let any queued microtasks/timers settle, then verify the renewed generation works on WebGL2.
        await new Promise((r) => setTimeout(r, 150));
        const freshAttach = await fresh.attachGpu(document.createElement("canvas"));
        let freshPixel: number[] | null = null;
        if (freshAttach.ok) {
          const r = fresh.renderGpu(16, 16, { zoom: 1, x: 0, y: 0, dpr: 1 }, [0, 1, 0, 1], false);
          if (r.ok) {
            const px = await fresh.gpuPixels();
            if (px.ok) freshPixel = Array.from(px.value.slice(0, 4));
          }
        }
        fresh.dispose();
        return {
          faultCode: fault.ok ? 0 : fault.code,
          epochA: a.epoch,
          epochB: b.epoch,
          oldDead: second.dead,
          freshDead: freshDeadBeforeDispose,
          oldOutcome,
          freshAttachOk: freshAttach.ok,
          freshPixel,
        };
      },
      {
        modUrl: "/webgl/engine.js",
        wasmUrl: "/webgl/engine_bg.wasm",
        facadeUrl: "/facade.js",
      },
    );
    expect(crashed).toBe(false);
    expect(errors).toEqual([]);
    expect(out.faultCode).toBe(100);
    expect(out.epochA).toBe(1);
    expect(out.epochB).toBe(1);
    expect(out.oldDead).toBe(true);
    expect(out.freshDead).toBe(false);
    expect(out.oldOutcome).toMatchObject({ ok: false, code: 100 });
    expect(out.freshAttachOk).toBe(true);
    expect(out.freshPixel).toEqual([0, 255, 0, 255]);
  });

  test("cancels pending gpuFinished and gpuPixels waits immediately on Engine.free() with zero further polls", async ({
    page,
  }) => {
    await page.goto(baseUrl);
    const out = await page.evaluate(async (modUrl) => {
      const m = (await import(modUrl)) as typeof import("@drawpane/engine/webgl-glue");
      await m.default();
      const runCase = async (waitBeforeFreeMs: number) => {
        const init = await m.createGpu(document.createElement("canvas"), 0);
        if (!init.ok) throw new Error(init.message);
        const engine = new m.Engine(0, 0);
        const attached = engine.attachGpu?.(init);
        init.free();
        if (!attached?.ok) throw new Error(attached?.message ?? "no attachGpu");
        attached.free();

        const proto = WebGL2RenderingContext.prototype;
        const original = proto.getSyncParameter;
        let checks = 0;
        proto.getSyncParameter = function (sync, parameter) {
          if (parameter === this.SYNC_STATUS) {
            checks++;
            return this.UNSIGNALED;
          }
          return original.call(this, sync, parameter);
        };
        try {
          const render = engine.renderGpu?.(
            65,
            17,
            1,
            0,
            0,
            1,
            new Float32Array([0, 0, 0, 1]),
            false,
            0,
          );
          if (!render?.ok) throw new Error(render?.message ?? "no renderGpu");
          render.free();

          let finishedResult: { ok: boolean; code: number; message: string } | null = null;
          const finished = (engine.gpuFinished?.() ?? Promise.resolve(undefined)).then(
            (res: unknown) => {
              if (res && typeof res === "object" && "ok" in res) {
                const o = res as { ok: boolean; code: number; message: string; free(): void };
                finishedResult = { ok: o.ok, code: o.code, message: o.message };
                o.free();
              } else {
                finishedResult = { ok: true, code: 0, message: "" };
              }
            },
          );
          let readbackResult: { ok: boolean; code: number; message: string } | null = null;
          const readback = (engine.gpuPixels?.() ?? Promise.resolve(new Uint8Array())).then(
            (res: unknown) => {
              if (res instanceof Uint8Array) {
                readbackResult = { ok: true, code: 0, message: "" };
              } else if (res && typeof res === "object" && "ok" in res) {
                const o = res as { ok: boolean; code: number; message: string; free(): void };
                readbackResult = { ok: o.ok, code: o.code, message: o.message };
                o.free();
              }
            },
          );

          // Overflow MAX_FINISHED_WAITERS (8) while waits are stalled to verify the cap.
          const extras = Array.from(
            { length: 8 },
            () => engine.gpuFinished?.() ?? Promise.resolve(undefined),
          );
          const overflow = await extras[7];
          const overflowCode =
            overflow && typeof overflow === "object" && "code" in overflow
              ? (overflow as { code: number; free(): void }).code
              : 0;
          if (overflow && typeof overflow === "object" && "free" in overflow) {
            (overflow as { free(): void }).free();
          }

          if (waitBeforeFreeMs > 0) {
            await new Promise((r) => setTimeout(r, waitBeforeFreeMs));
          }
          engine.free();
          const checksWhenFreed = checks;
          await Promise.all([
            finished,
            readback,
            ...extras.slice(0, 7).map((p) =>
              p.then((o: unknown) => {
                if (o && typeof o === "object" && "free" in o) (o as { free(): void }).free();
              }),
            ),
          ]);
          await new Promise((r) => setTimeout(r, 350));
          return {
            checksWhenFreed,
            checksAfterFree: checks - checksWhenFreed,
            finishedResult,
            readbackResult,
            overflowCode,
          };
        } finally {
          proto.getSyncParameter = original;
        }
      };

      const immediate = await runCase(0);
      const afterPolling = await runCase(120);
      return { immediate, afterPolling };
    }, "/webgl/engine.js");

    for (const c of [out.immediate, out.afterPolling]) {
      expect(c.checksAfterFree).toBe(0);
      expect(c.finishedResult).toMatchObject({ ok: false, code: 11 });
      expect(c.readbackResult).toMatchObject({ ok: false, code: 11 });
      expect(c.overflowCode).toBe(11);
    }
    expect(out.afterPolling.checksWhenFreed).toBeGreaterThan(0);
  });

  test("validates WebGL2 device MAX_TEXTURE_SIZE before frame and image allocation", async ({
    page,
  }) => {
    await page.goto(baseUrl);
    const out = await page.evaluate(async (modUrl) => {
      const m = (await import(modUrl)) as typeof import("@drawpane/engine/webgl-glue");
      await m.default();
      const proto = WebGL2RenderingContext.prototype;
      const original = proto.getParameter;

      // 1) A 4096-capped device starts, refuses 4097px frames and images with Limit (4), and stays healthy.
      proto.getParameter = function (parameter) {
        if (parameter === this.MAX_TEXTURE_SIZE || parameter === this.MAX_RENDERBUFFER_SIZE) {
          return 4096;
        }
        return original.call(this, parameter);
      };
      type OutcomeInfo = { ok: boolean; code: number; message: string };
      let cap4096: {
        frame: OutcomeInfo;
        image: OutcomeInfo;
        checked: OutcomeInfo;
        okRender: boolean;
      };
      try {
        const init = await m.createGpu(document.createElement("canvas"), 0);
        if (!init.ok) {
          const msg = init.message;
          init.free();
          throw new Error(`4096 cap refused unexpectedly: ${msg}`);
        }
        const engine = new m.Engine(0, 0);
        const attached = engine.attachGpu?.(init);
        init.free();
        attached?.free();
        const r = engine.renderGpu?.(
          4097,
          17,
          1,
          0,
          0,
          1,
          new Float32Array([0, 0, 0, 1]),
          false,
          0,
        );
        if (!r) throw new Error("no renderGpu");
        const frame = { ok: r.ok, code: r.code, message: r.message };
        r.free();
        const img = engine.putImage(1, 4097, 2, new Uint8Array(4097 * 2 * 4), false);
        const image = { ok: img.ok, code: img.code, message: img.message };
        img.free();
        const health = engine.gpuCheck?.();
        if (!health) throw new Error("no gpuCheck");
        const checked = { ok: health.ok, code: health.code, message: health.message };
        health.free();
        // A legal 65x17 frame still renders cleanly on the same healthy device.
        const okFrame = engine.renderGpu?.(
          65,
          17,
          1,
          0,
          0,
          1,
          new Float32Array([0, 0, 0, 1]),
          false,
          0,
        );
        const okRender = okFrame?.ok ?? false;
        okFrame?.free();
        engine.free();
        cap4096 = { frame, image, checked, okRender };
      } finally {
        proto.getParameter = original;
      }

      // 2) A 1024-capped device cannot hold the 2048px glyph atlas and is refused at startup.
      proto.getParameter = function (parameter) {
        if (parameter === this.MAX_TEXTURE_SIZE || parameter === this.MAX_RENDERBUFFER_SIZE) {
          return 1024;
        }
        return original.call(this, parameter);
      };
      let cap1024: OutcomeInfo;
      try {
        const init = await m.createGpu(document.createElement("canvas"), 0);
        cap1024 = { ok: init.ok, code: init.code, message: init.message };
        init.free();
      } finally {
        proto.getParameter = original;
      }

      return { cap4096, cap1024 };
    }, "/webgl/engine.js");

    expect(out.cap4096.frame).toMatchObject({ ok: false, code: 4 });
    expect(out.cap4096.image).toMatchObject({ ok: false, code: 4 });
    expect(out.cap4096.checked).toMatchObject({ ok: true, code: 0 });
    expect(out.cap4096.okRender).toBe(true);
    expect(out.cap1024).toMatchObject({ ok: false, code: 9 });
  });
});
