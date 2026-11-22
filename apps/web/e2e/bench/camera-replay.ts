import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Camera, Editor } from "@drawpane/editor";
import type { Page } from "@playwright/test";
import type { FrameStats, MotionCapture } from "../../src/editor/frame-stats";

const REPLAY_TIMEOUT = 120_000;
const SCORE_TIMEOUT = 10 * 60_000;
let nextBinding = 0;

export type ReplayScore =
  | { pass: boolean; ppd: number; frames: Array<{ step: number; pass: boolean }>; settle: unknown }
  | { pass: false; error: string };

interface ReplayEntry {
  step: number;
  camera: { x: number; y: number; zoom: number };
  width: number;
  height: number;
  dpr: number;
  shown: string;
  exact: string;
}

/**
 * Repeats the camera inputs outside the interval benchmark. Each saved frame's GPU copy
 * is submitted with that frame and kept only when that sequence was confirmed presented.
 */
async function captureReplay(
  page: Page,
  kind: "pan" | "zoom",
  zoom: number | "fit",
  frames: number,
  dir: string,
): Promise<void> {
  const manifest: Array<Omit<ReplayEntry, "shown" | "exact">> = [];
  const binding = `drawpaneSaveReplayFrame${nextBinding++}`;
  await page.exposeFunction(binding, ({ shown, exact, ...entry }: ReplayEntry) => {
    writeFileSync(join(dir, `${entry.step}-shown.rgba`), Buffer.from(shown, "base64"));
    writeFileSync(join(dir, `${entry.step}-exact.rgba`), Buffer.from(exact, "base64"));
    manifest.push(entry);
  });
  const lastStep = await page.evaluate(
    async ({ binding, kind, zoom, frames, native, timeout }) => {
      const w = window as unknown as {
        drawpane: Editor;
        drawpaneFrames: FrameStats;
      };
      const save = (window as unknown as Record<string, (entry: ReplayEntry) => Promise<void>>)[
        binding
      ];
      if (!save) throw new Error("Camera replay output is unavailable");
      const e = w.drawpane;
      const stats = w.drawpaneFrames;
      const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const deadline = async (pass: () => boolean, label: string) => {
        const until = performance.now() + timeout;
        do {
          if (pass()) return;
          await raf();
        } while (performance.now() < until);
        throw new Error(`Camera replay timed out waiting for ${label}`);
      };
      const rgba = (data: Uint8Array): string => {
        let raw = "";
        for (let at = 0; at < data.length; at += 0x8000) {
          raw += String.fromCharCode(...data.subarray(at, at + 0x8000));
        }
        return btoa(raw);
      };
      type Capture = {
        sequence: number;
        camera: Camera;
        width: number;
        height: number;
        dpr: number;
        data: Promise<Uint8Array | Error>;
      };
      const samples = new Map<Camera, Capture>();
      const wanted = new Map<Camera, number>();
      const pending = new Map<number, Capture>();
      const read = new Set<Camera>();
      const capture = (admit: (camera: Camera, exact: boolean) => boolean): MotionCapture => ({
        submitted(sequence, camera, width, height, exact, pixels) {
          if (admit(camera, exact)) {
            pending.set(sequence, {
              sequence,
              camera,
              width,
              height,
              dpr: devicePixelRatio,
              data: pixels().catch((error: unknown) => new Error(String(error))),
            });
          }
        },
        confirmed(sequence) {
          const frame = pending.get(sequence);
          if (frame) samples.set(frame.camera, frame);
          // Presentation probes coalesce. Earlier submissions cannot be confirmed later.
          for (const n of pending.keys()) if (n <= sequence) pending.delete(n);
        },
      });

      try {
        if (zoom === "fit") e.zoomToFit();
        else e.zoomTo(zoom);
        await raf();
        await deadline(() => stats.exact, "the starting exact view");
        stats.beginMotion(native);
        stats.motionCapture = capture((camera) => {
          if (!wanted.has(camera) || read.has(camera)) return false;
          read.add(camera);
          return true;
        });

        const centre = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        for (let step = 0; step < frames; step++) {
          const forward = step % 120 < 60;
          const camera = e.s.camera;
          const next =
            kind === "zoom"
              ? camera.zoomAt(centre, camera.zoom * (forward ? 1.03 : 1 / 1.03))
              : camera.pan(forward ? 6 : -6, forward ? 3 : -3);
          wanted.set(next, step);
          e.state.set({ camera: next });
          await raf();
        }
        const lastCamera = e.s.camera;
        await deadline(() => samples.has(lastCamera), "the last motion presentation");
        const shown = [...samples.values()].sort((a, b) => a.sequence - b.sequence);
        if (shown.length < 2) {
          throw new Error("Camera replay confirmed fewer than two motion presentations");
        }

        pending.clear();
        samples.clear();
        stats.beginMotion(true);
        stats.motionCapture = capture((camera, exact) => exact && camera === e.s.camera);
        for (const frame of shown) {
          const step = wanted.get(frame.camera);
          if (step === undefined) throw new Error("Presented camera lost its input step");
          e.state.set({ camera: frame.camera });
          stats.redraw();
          await deadline(() => samples.has(frame.camera), "a native exact presentation");
          const reference = samples.get(frame.camera);
          samples.clear();
          if (
            !reference ||
            reference.width !== frame.width ||
            reference.height !== frame.height ||
            reference.dpr !== frame.dpr
          ) {
            throw new Error("Camera replay reference changed its pixel grid");
          }
          const [pixels, exact] = await Promise.all([frame.data, reference.data]);
          if (pixels instanceof Error) throw pixels;
          if (exact instanceof Error) throw exact;
          if (pixels.length !== frame.width * frame.height * 4 || exact.length !== pixels.length) {
            throw new Error("Camera replay received incomplete pixels");
          }
          const { x, y, zoom } = frame.camera;
          await save({
            step,
            camera: { x, y, zoom },
            width: frame.width,
            height: frame.height,
            dpr: frame.dpr,
            shown: rgba(pixels),
            exact: rgba(exact),
          });
        }
        return frames - 1;
      } finally {
        stats.motionCapture = null;
        stats.endMotion();
      }
    },
    {
      binding,
      kind,
      zoom,
      frames,
      native: process.env.BENCH_W4_NATIVE === "1",
      timeout: REPLAY_TIMEOUT,
    },
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ lastStep, entries: manifest }, null, 2),
  );
}

/** Scores a single gesture and releases the private capture as soon as scoring finishes. */
export async function cameraReplay(
  page: Page,
  kind: "pan" | "zoom",
  zoom: number | "fit",
  frames: number,
): Promise<ReplayScore> {
  const ppd = Number(process.env.BENCH_W4_REPLAY_PPD);
  if (!Number.isFinite(ppd) || ppd <= 0) {
    return {
      pass: false,
      error: "Set BENCH_W4_REPLAY_PPD to the target display's pixels per degree",
    };
  }
  if (!Number.isInteger(frames) || frames < 2) {
    return { pass: false, error: "Camera replay requires at least two input frames" };
  }
  const dir = mkdtempSync(join(tmpdir(), "drawpane-motion-"));
  try {
    await captureReplay(page, kind, zoom, frames, dir);
    const script = new URL("../../../../tools/gpu-bench/score-camera-replay.py", import.meta.url);
    const score = execFileSync(
      process.env.BENCH_W4_REPLAY_PYTHON ?? "python3",
      [fileURLToPath(script), dir, "--ppd", String(ppd)],
      { encoding: "utf8", timeout: SCORE_TIMEOUT },
    );
    return JSON.parse(score) as ReplayScore;
  } catch (error) {
    return { pass: false, error: String(error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
