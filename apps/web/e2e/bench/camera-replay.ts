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
  phase: "shown" | "exact";
  pixels: string;
}

/**
 * Repeats the camera inputs outside the interval benchmark, waiting for each frame to
 * present and read back before sending another camera.
 */
async function captureReplay(
  page: Page,
  kind: "pan" | "zoom",
  zoom: number | "fit",
  frames: number,
  dir: string,
  panStep: { x: number; y: number },
): Promise<void> {
  const manifest: Array<Omit<ReplayEntry, "phase" | "pixels">> = [];
  const binding = `drawpaneSaveReplayFrame${nextBinding++}`;
  await page.exposeFunction(binding, ({ phase, pixels, ...entry }: ReplayEntry) => {
    writeFileSync(join(dir, `${entry.step}-${phase}.rgba`), Buffer.from(pixels, "base64"));
    if (phase === "exact") manifest.push(entry);
  });
  const lastStep = await page.evaluate(
    async ({ binding, kind, zoom, frames, panStep, native, timeout }) => {
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
      type Frame = {
        camera: Camera;
        width: number;
        height: number;
        dpr: number;
      };
      type Captured = Frame & { data: Promise<Uint8Array | Error> };
      type Request = {
        camera: Camera;
        exact: boolean;
        captured?: Captured;
      };
      let request: Request | null = null;
      const pending = new Map<number, Frame & { pixels: () => Promise<Uint8Array> }>();
      const capture: MotionCapture = {
        submitted(sequence, camera, width, height, exact, pixels) {
          if (
            !request ||
            request.captured ||
            (request.exact && !exact) ||
            camera.x !== request.camera.x ||
            camera.y !== request.camera.y ||
            camera.zoom !== request.camera.zoom
          ) {
            return;
          }
          pending.set(sequence, { camera, width, height, dpr: devicePixelRatio, pixels });
        },
        confirmed(sequence) {
          const frame = pending.get(sequence);
          if (request && !request.captured && frame) {
            const { pixels, ...viewport } = frame;
            request.captured = {
              ...viewport,
              data: pixels().catch((error: unknown) => new Error(String(error))),
            };
          }
          // Presentation probes coalesce. Earlier submissions cannot be confirmed later.
          for (const n of pending.keys()) if (n <= sequence) pending.delete(n);
        },
      };
      const drawAndCapture = async (
        camera: Camera,
        step: number,
        phase: ReplayEntry["phase"],
        match?: Frame,
      ): Promise<Frame> => {
        pending.clear();
        const wanted: Request = { camera, exact: phase === "exact" };
        request = wanted;
        e.state.set({ camera });
        if (wanted.exact) stats.redraw();
        await deadline(() => !!wanted.captured, `${phase} presentation at input ${step + 1}`);
        const captured = wanted.captured;
        if (!captured) throw new Error("Camera replay lost a confirmed frame");
        const { data, ...frame } = captured;
        const pixels = await data;
        if (pixels instanceof Error) throw pixels;
        if (
          match &&
          (frame.width !== match.width || frame.height !== match.height || frame.dpr !== match.dpr)
        ) {
          throw new Error("Camera replay reference changed its pixel grid");
        }
        if (pixels.length !== frame.width * frame.height * 4) {
          throw new Error("Camera replay received incomplete pixels");
        }
        const { x, y, zoom } = frame.camera;
        await save({ ...frame, step, camera: { x, y, zoom }, phase, pixels: rgba(pixels) });
        request = null;
        return frame;
      };

      try {
        if (zoom === "fit") e.zoomToFit();
        else e.zoomTo(zoom);
        await raf();
        await deadline(() => stats.exact, "the starting exact view");
        stats.beginMotion(native);
        stats.motionCapture = capture;

        const centre = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        const shown: Frame[] = [];
        for (let step = 0; step < frames; step++) {
          const forward = step % 120 < 60;
          const camera = e.s.camera;
          const next =
            kind === "zoom"
              ? camera.zoomAt(centre, camera.zoom * (forward ? 1.03 : 1 / 1.03))
              : camera.pan(forward ? panStep.x : -panStep.x, forward ? panStep.y : -panStep.y);
          shown.push(await drawAndCapture(next, step, "shown"));
        }
        stats.beginMotion(true);
        for (const [step, frame] of shown.entries()) {
          await drawAndCapture(frame.camera, step, "exact", frame);
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
      panStep,
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
  panStep = { x: 6, y: 3 },
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
    await captureReplay(page, kind, zoom, frames, dir, panStep);
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
