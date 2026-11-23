import type { Page } from "@playwright/test";

type Stamp = { n: number; at: number };
type Camera = { x: number; y: number; zoom: number };
type View = {
  backend: string;
  software: boolean;
  readsBack: boolean;
  shown: Stamp;
  stamps: { drawn?: Stamp } | null;
  last: { n: number; pageId: string; exact: boolean; tiles: { pending: number } };
};

type Sample = { time: number; handled: number };
type Probe = {
  raf: Sample[];
  inputs: Sample[];
  longTasks: { start: number; duration: number }[];
  firstShown: number | null;
  reset(): void;
};

type BenchWindow = {
  drawpane?: { s: { status: string; camera: Camera; selection: string[] } };
  drawpaneEngineView?: View;
  drawpaneFrames?: { exact: boolean };
  realInputProbe: Probe;
};

// Must be self-contained: Playwright runs this before any app code on each navigation.
function installProbe() {
  const w = window as unknown as BenchWindow;
  const probe: Probe = {
    raf: [],
    inputs: [],
    longTasks: [],
    firstShown: null,
    reset() {
      probe.raf.length = 0;
      probe.inputs.length = 0;
      probe.longTasks.length = 0;
      if (w.drawpaneEngineView) w.drawpaneEngineView.stamps = {};
    },
  };
  w.realInputProbe = probe;

  const frame = (time: number) => {
    probe.raf.push({ time, handled: performance.now() });
    const view = w.drawpaneEngineView;
    if (view) {
      view.stamps ??= {};
      if (view.shown.n > 0) probe.firstShown ??= view.shown.at;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  function record(e: Event) {
    const handled = performance.now();
    probe.inputs.push({ time: e.timeStamp, handled });
    const view = w.drawpaneEngineView;
    // An exact frame for an earlier camera during the gesture cannot end the sample.
    if (view?.stamps?.drawn) view.stamps = {};
  }
  window.addEventListener("wheel", record, { capture: true, passive: true });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.shiftKey && /^Digit[012]$/.test(e.code)) record(e);
    },
    { capture: true },
  );

  new PerformanceObserver((list) => {
    for (const task of list.getEntries()) {
      probe.longTasks.push({ start: task.startTime, duration: task.duration });
    }
  }).observe({ type: "longtask", buffered: true });
}

export async function openProbe(page: Page) {
  await page.addInitScript(installProbe);
}

export async function ready(page: Page, pageId: string, board?: string) {
  await page.waitForFunction(
    ({ pageId, board }) => {
      const w = window as unknown as BenchWindow;
      return (
        w.drawpane?.s.status === "live" &&
        w.drawpaneEngineView?.last.pageId === pageId &&
        w.drawpaneEngineView.shown.n > 0 &&
        (!board || w.drawpane.s.selection.includes(board))
      );
    },
    { pageId, board },
    { timeout: 90_000, polling: 100 },
  );
}

export async function resetProbe(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as BenchWindow;
    w.realInputProbe.reset();
    return { timeOrigin: performance.timeOrigin, camera: w.drawpane?.s.camera };
  });
}

export async function collectProbe(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as BenchWindow;
    const view = w.drawpaneEngineView;
    const { raf, inputs, longTasks, firstShown } = w.realInputProbe;
    const drawn = view?.stamps?.drawn;
    return {
      raf,
      inputs,
      longTasks,
      firstShown,
      end: performance.now(),
      camera: w.drawpane?.s.camera,
      backend: view?.backend,
      software: view?.software,
      readsBack: view?.readsBack,
      exactAt:
        view?.last.exact && view.last.tiles.pending === 0 && w.drawpaneFrames?.exact
          ? (drawn?.at ?? null)
          : null,
    };
  });
}

export async function waitForExact(page: Page, timeout: number) {
  const result = await page
    .waitForFunction(
      () => {
        const w = window as unknown as BenchWindow;
        return w.drawpaneFrames?.exact && w.drawpaneEngineView?.stamps?.drawn;
      },
      undefined,
      { timeout, polling: 150 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Error && e.name === "TimeoutError")) throw e;
      return null;
    });
  await result?.dispose();
}

const round = (n: number) => Math.round(n * 10) / 10;
const VSYNC_MS = 1000 / 60;

/** Cadence counts missed 60 Hz ticks between consecutive rAFs, including gaps at the boundaries. */
function cadence(raf: Sample[], start: number, stop: number) {
  const preceding = raf.findLastIndex((f) => f.time <= start);
  const following = raf.findIndex((f) => f.time >= stop);
  const frames = raf.slice(Math.max(0, preceding), following < 0 ? undefined : following + 1);
  const gaps = frames.slice(1).map((f, i) => f.time - (frames[i] as Sample).time);
  const dropped = gaps.reduce((n, gap) => n + Math.max(0, Math.round(gap / VSYNC_MS) - 1), 0);
  const span = gaps.reduce((n, gap) => n + gap, 0);
  return {
    fps: span > 0 ? round((gaps.length * 1000) / span) : null,
    dropped,
    droppedPct: gaps.length > 0 ? round((100 * dropped) / (gaps.length + dropped)) : null,
    worstFrameMs: gaps.length > 0 ? round(Math.max(...gaps)) : null,
  };
}

function lag(inputs: Sample[], raf: Sample[]) {
  let frame = 0;
  const delays: number[] = [];
  for (const input of inputs) {
    let next = raf[frame];
    while (next && next.handled < input.handled) next = raf[++frame];
    if (!next) break;
    delays.push(next.handled - input.time);
  }
  if (!delays.length) return null;
  delays.sort((a, b) => a - b);
  const at = (p: number) => round(delays[Math.floor(p * (delays.length - 1))] as number);
  return { samples: delays.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

export const SETTLE_MS = 4000;

export function summarize(
  data: Awaited<ReturnType<typeof collectProbe>>,
  input?: { start: number; stop: number; shortcut: boolean },
) {
  const start = input?.start ?? 0;
  const sentEnd = input?.stop ?? 0;
  const handledEnd = Math.max(sentEnd, data.inputs.at(-1)?.handled ?? 0);
  const cadenceEnd = input
    ? Math.min(data.end, input.shortcut ? sentEnd + 1000 : handledEnd + VSYNC_MS)
    : (data.exactAt ?? data.end);
  const windowEnd = input ? Math.min(data.end, handledEnd + SETTLE_MS) : cadenceEnd;
  const longestTask = data.longTasks
    .filter((task) => task.start <= windowEnd && task.start + task.duration >= start)
    .reduce((ms, task) => Math.max(ms, task.duration), 0);
  return {
    ...cadence(data.raf, start, cadenceEnd),
    lagMs: input ? lag(data.inputs, data.raf) : null,
    backlogMs: input ? round(handledEnd - sentEnd) : null,
    // Time is relative to the sender stopping, so delays in the input queue count.
    exactMs:
      data.exactAt !== null && data.exactAt <= windowEnd
        ? round(Math.max(0, data.exactAt - sentEnd))
        : null,
    longestTaskMs: longestTask ? round(longestTask) : null,
    firstShownMs: input || data.firstShown === null ? null : round(data.firstShown),
  };
}
