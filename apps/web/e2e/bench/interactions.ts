/**
 * What a designer does to a file, measured from the input to the frame that
 * shows it: hovering, selecting on the canvas and in the layers panel,
 * dragging, resizing and nudging a layer, typing, changing a fill and an
 * effect, undoing, and panning and zooming up close. Shared by the
 * interaction benchmark (`interactions.spec.ts`), which runs it on a simple
 * 10,000-layer file, a generated effect-heavy one and, with BENCH_FILE, a
 * real kit.
 *
 * Each case is named, so runs on different commits line up. For each it
 * reports:
 *
 * - **answer**: ms from the input event (its `timeStamp`) to the end of the
 *   first frame that shows its effect, median and worst of its repeats (a
 *   drag's steps, a word's keys);
 * - **content / overlay**: what that frame spent drawing the document and
 *   the selection;
 * - **exact**: ms from the input until the canvas is exact again (effects
 *   and tiles drawn in later frames included);
 * - **long task**: the longest task that ran meanwhile.
 *
 * Frames are logged by wrapping the canvas's `drawpaneFrames.record`, which
 * the canvas calls once a frame after drawing.
 */
import type { CDPSession, Page } from "@playwright/test";
import { pan, type Summary, zoom } from "./frames";

export interface Answer {
  /** Repeats measured. */
  n: number;
  answer: { p50: number; max: number };
  content: { p50: number; max: number };
  overlay: { p50: number; max: number };
  /** Until the canvas was exact again, after the last repeat. */
  exact: number;
  /** Until the page was quiet (no long task for a while) after the last repeat: work set off later, such as the export preview, counts. */
  quiet: number;
  /** The longest task from the first input until quiet. */
  longTask: number;
}

export type CaseResult = Answer | Summary;

/** The layers a board's cases act on, chosen from the document. */
export interface Targets {
  board: string;
  /** A layer the size of a control or a card, glass or background blur if the board has one. */
  move: string;
  /** Another layer to hover and click, on the board. */
  hover: string;
  text: string | null;
  fill: string | null;
  effect: string | null;
}

type Probe = {
  input: number;
  armed: boolean;
  want: (() => boolean) | null;
  answered: number;
  content: number;
  overlay: number;
  longest: number;
  frames: number;
  /** When the last long task ended (any, armed or not). */
  lastTask: number;
  /** The last long tasks: start and duration. */
  tasks: Array<[number, number]>;
};

/** Installs the frame log and the input listener (once per page load). */
export async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __probe?: Probe;
      drawpaneFrames: { record(content: number, overlay: number): void };
    };
    if (w.__probe) return;
    const p: Probe = {
      input: 0,
      armed: false,
      want: null,
      answered: 0,
      content: 0,
      overlay: 0,
      longest: 0,
      frames: 0,
      lastTask: 0,
      tasks: [],
    };
    w.__probe = p;
    for (const type of ["pointerdown", "pointermove", "pointerup", "keydown", "input", "wheel"])
      document.addEventListener(
        type,
        (e) => {
          if (p.armed && !p.input) p.input = e.timeStamp;
        },
        { capture: true },
      );
    const frames = w.drawpaneFrames;
    const record = frames.record.bind(frames);
    frames.record = (content: number, overlay: number) => {
      record(content, overlay);
      p.frames++;
      if (p.armed && p.input && !p.answered && p.want?.()) {
        p.answered = performance.now();
        p.content = content;
        p.overlay = overlay;
      }
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        p.lastTask = Math.max(p.lastTask, e.startTime + e.duration);
        p.tasks.push([e.startTime, e.duration]);
        if (p.tasks.length > 500) p.tasks.shift();
        // Since the input, answered or not: work an input sets off later counts too.
        if (p.input && e.startTime + e.duration >= p.input)
          p.longest = Math.max(p.longest, e.duration);
      }
    }).observe({ type: "longtask" });
  });
}

/**
 * Arms the probe: the next input starts the clock, and the first frame after
 * it in which `want` (source of a function of the debug handle `e`, run in
 * the page) holds stops it. `programmatic` starts the clock now instead, for
 * changes made through the editor (as the inspector makes them).
 */
async function arm(page: Page, want: string, programmatic = false): Promise<void> {
  await page.evaluate(
    ({ want, programmatic }) => {
      const w = window as unknown as { __probe: Probe; drawpane: unknown };
      const p = w.__probe;
      const test = new Function("e", `return (${want})(e);`) as (e: unknown) => boolean;
      p.want = () => test(w.drawpane);
      p.input = programmatic ? performance.now() : 0;
      p.answered = 0;
      p.content = 0;
      p.overlay = 0;
      p.longest = 0;
      p.armed = true;
    },
    { want, programmatic },
  );
}

type Reading = { answer: number; content: number; overlay: number; longest: number };

/** Waits for the armed probe's answer. */
async function answered(page: Page, timeout = 120_000): Promise<Reading> {
  await page.waitForFunction(
    () => (window as unknown as { __probe: Probe }).__probe.answered > 0,
    undefined,
    { timeout, polling: "raf" },
  );
  return page.evaluate(() => {
    const p = (window as unknown as { __probe: Probe }).__probe;
    p.armed = false;
    return {
      answer: p.answered - p.input,
      content: p.content,
      overlay: p.overlay,
      longest: p.longest,
    };
  });
}

/** Ms until the canvas is exact again, from `since` (a page clock reading). */
async function exactAfter(page: Page, since: number): Promise<number> {
  await page.waitForFunction(
    () => (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames.exact,
    undefined,
    { timeout: 600_000, polling: 100 },
  );
  // A zoom or an image may settle a beat later; one more look.
  await page.waitForTimeout(250);
  await page.waitForFunction(
    () => (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames.exact,
    undefined,
    { timeout: 600_000, polling: 100 },
  );
  return page.evaluate((since) => performance.now() - since, since);
}

const now = (page: Page) => page.evaluate(() => performance.now());

/**
 * Ms from `since` (a page clock reading) until the page went quiet: the end of the last long
 * task, once none has run for a while (work an input sets off a beat later, such as the
 * inspector's export preview, counts).
 */
async function quietAfter(page: Page, since: number): Promise<After> {
  return page.evaluate(
    (since) =>
      new Promise<After>((resolve) => {
        const p = (window as unknown as { __probe: Probe }).__probe;
        const QUIET = 1500;
        // A timer that fires late saw the main thread busy, whether or not the long task
        // has been reported yet: its end counts as much as a reported one's.
        let busyEnd = 0;
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          if (now - last > 120) busyEnd = now;
          last = now;
          const end = Math.max(busyEnd, p.lastTask);
          if (now - Math.max(end, p.input, since) > QUIET) {
            let longest = 0;
            for (const [start, duration] of p.tasks)
              if (start + duration >= since) longest = Math.max(longest, duration);
            resolve({ quiet: Math.max(0, end - since), longest });
          } else setTimeout(tick, 50);
        };
        setTimeout(tick, 50);
      }),
    since,
  );
}

/** After the last input: until the page was quiet, and the longest task meanwhile. */
interface After {
  quiet: number;
  longest: number;
}

function summarise(readings: Reading[], exact: number, after?: After): Answer {
  const stat = (k: keyof Reading) => {
    const v = readings.map((r) => r[k]).sort((a, b) => a - b);
    const round = (n: number) => Math.round(n * 10) / 10;
    return { p50: round(v[Math.floor(v.length / 2)] ?? 0), max: round(v.at(-1) ?? 0) };
  };
  return {
    n: readings.length,
    answer: stat("answer"),
    content: stat("content"),
    overlay: stat("overlay"),
    exact: Math.round(exact),
    quiet: Math.round(after?.quiet ?? 0),
    longTask: Math.round(Math.max(after?.longest ?? 0, ...readings.map((r) => r.longest))),
  };
}

/** Waits until the canvas is exact. */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await exactAfter(page, 0);
}

/** Where a layer's centre is in the viewport (CSS px), and its size on screen. */
async function onScreen(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; w: number; h: number }> {
  const r = await page.evaluate((id) => {
    type P = { x: number; y: number };
    const e = (
      window as unknown as {
        drawpane: {
          scene: { corners(id: string): P[] | null };
          s: { camera: { toScreen(p: P): P } };
        };
      }
    ).drawpane;
    const corners = e.scene.corners(id) ?? [];
    const pts = corners.map((c) => e.s.camera.toScreen(c));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const l = Math.min(...xs);
    const t = Math.min(...ys);
    return {
      x: rect.left + (l + Math.max(...xs)) / 2,
      y: rect.top + (t + Math.max(...ys)) / 2,
      w: Math.max(...xs) - l,
      h: Math.max(...ys) - t,
    };
  }, id);
  return r;
}

/** Centres the view on a layer at `zoom` and waits until the canvas is exact. */
export async function focusOn(page: Page, id: string, zoom: number): Promise<void> {
  await page.evaluate(
    ({ id, zoom }) => {
      type Rect = { x: number; y: number; width: number; height: number };
      const e = (
        window as unknown as {
          drawpane: {
            scene: { bounds(id: string): Rect | null };
            centerOn(p: { x: number; y: number }): void;
            zoomTo(z: number): void;
          };
        }
      ).drawpane;
      const b = e.scene.bounds(id);
      e.zoomTo(zoom);
      if (b) e.centerOn({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    },
    { id, zoom },
  );
  await settle(page);
}

/**
 * The layers a board's cases act on: to move, the largest glass or
 * background blur layer between 40 and 480 px a side (else the largest
 * child of that size); to hover, another layer near the middle; the text
 * with the most glyphs drawn from saved outlines (else any); a layer with
 * a solid fill; a layer with a shadow.
 */
export async function pickTargets(page: Page, board: string): Promise<Targets> {
  return page.evaluate((board) => {
    type Node = { id: string; type: string; props: Record<string, unknown> };
    type Rect = { x: number; y: number; width: number; height: number };
    const e = (
      window as unknown as {
        drawpane: {
          doc: { get(id: string): Node | undefined; childIds(id: string): readonly string[] };
          scene: { bounds(id: string): Rect | null; isVisible(id: string): boolean };
        };
      }
    ).drawpane;
    const all: Node[] = [];
    const walk = (id: string) => {
      for (const c of e.doc.childIds(id)) {
        const n = e.doc.get(c);
        if (!n || n.props.visible === false) continue;
        all.push(n);
        walk(c);
      }
    };
    walk(board);
    const effects = (n: Node) =>
      ((n.props.effects as Array<{ type: string; visible?: boolean }> | undefined) ?? []).filter(
        (x) => x.visible !== false,
      );
    const size = (n: Node) => {
      const b = e.scene.bounds(n.id);
      return b ? { w: b.width, h: b.height, area: b.width * b.height } : null;
    };
    const fits = (n: Node) => {
      const s = size(n);
      return !!s && s.w >= 40 && s.h >= 40 && s.w <= 480 && s.h <= 480;
    };
    const largest = (list: Node[]) =>
      list.sort((a, b) => (size(b)?.area ?? 0) - (size(a)?.area ?? 0))[0] ?? null;
    const readers = all.filter(
      (n) => fits(n) && effects(n).some((x) => x.type === "glass" || x.type === "background-blur"),
    );
    const move = largest(readers) ?? largest(all.filter(fits)) ?? e.doc.get(board);
    const b = e.scene.bounds(board) as Rect;
    const mid = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const near = all
      .filter((n) => n.id !== move?.id && fits(n))
      .map((n) => {
        const r = e.scene.bounds(n.id) as Rect;
        return { n, d: Math.hypot(r.x + r.width / 2 - mid.x, r.y + r.height / 2 - mid.y) };
      })
      .sort((a, c) => a.d - c.d)[0]?.n;
    const texts = all.filter((n) => n.type === "text");
    const glyphs = (n: Node) =>
      ((n.props.glyphLayout as { g?: number[] } | undefined)?.g?.length ?? 0) / 3;
    const text = texts.sort((a, c) => glyphs(c) - glyphs(a))[0] ?? null;
    const fill =
      all.find(
        (n) =>
          n.type !== "text" &&
          ((n.props.fills as Array<{ type: string }> | undefined) ?? []).some(
            (f) => f.type === "solid",
          ) &&
          fits(n),
      ) ?? null;
    const shadowed = (n: Node) =>
      effects(n).some((x) => x.type === "drop-shadow" || x.type === "inner-shadow");
    // A layer in the board with a shadow, else the board's own (a card's).
    const self = e.doc.get(board);
    const effect =
      all.find((n) => fits(n) && shadowed(n)) ?? (self && shadowed(self) ? self : null);
    return {
      board,
      move: (move as Node).id,
      hover: (near ?? move ?? { id: board }).id,
      text: text?.id ?? null,
      fill: fill?.id ?? null,
      effect: effect?.id ?? null,
    };
  }, board);
}

type Profiler = <T>(name: string, work: () => Promise<T>) => Promise<T>;

const noProfile: Profiler = (_name, work) => work();

/**
 * Runs every interaction on `targets.board` and returns the named results.
 * `profile` wraps each case (a CPU profile per case, when the caller wants
 * them). Leaves the document as it found it (each edit is undone).
 */
export async function interactions(
  page: Page,
  targets: Targets,
  {
    profile = noProfile,
    zooms = [1, 2, 4],
    frames = 60,
    repeats = 8,
  }: { profile?: Profiler; zooms?: number[]; frames?: number; repeats?: number } = {},
): Promise<Record<string, CaseResult>> {
  await installProbe(page);
  const out: Record<string, CaseResult> = {};
  const select = (ids: string[]) =>
    page.evaluate(
      (ids) =>
        (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select(ids),
      ids,
    );
  const run = async (name: string, work: () => Promise<CaseResult>) => {
    out[name] = await profile(name, work);
    await settle(page);
  };

  // Pans and zooms on the board, at fit and up close.
  await run("pan, fit", () => pan(page, "fit", frames));
  await run("zoom, fit", () => zoom(page, frames));
  for (const level of zooms) {
    await focusOn(page, targets.board, level);
    await run(`pan, ${level * 100}%`, () => pan(page, level, frames));
  }

  // The rest at 100% on the board (or fitting it, if it's larger than the screen).
  const frame = async () => {
    await focusOn(page, targets.board, 1);
    const fit = await page.evaluate((board) => {
      type Rect = { x: number; y: number; width: number; height: number };
      const e = (
        window as unknown as {
          drawpane: {
            scene: { bounds(id: string): Rect | null };
            s: { viewport: { width: number; height: number } };
          };
        }
      ).drawpane;
      const b = e.scene.bounds(board);
      return b
        ? Math.min(1, (0.8 * e.s.viewport.height) / b.height, (0.8 * e.s.viewport.width) / b.width)
        : 1;
    }, targets.board);
    if (fit < 1) await focusOn(page, targets.board, fit);
  };
  await frame();
  await select([]);
  await page.mouse.move(5, 450);
  await settle(page);

  // Hovering: the pointer onto a layer, then off it, each a repeat.
  await run("hover", async () => {
    const at = await onScreen(page, targets.hover);
    const readings: Reading[] = [];
    for (let i = 0; i < repeats; i++) {
      await arm(page, `(e) => e.s.hover !== null`);
      await page.mouse.move(at.x + (i % 3), at.y);
      readings.push(await answered(page));
      await arm(page, `(e) => e.s.hover === null`);
      await page.mouse.move(5, 450);
      readings.push(await answered(page));
    }
    return summarise(readings, 0);
  });

  // Clicking a layer on the canvas, then clicking empty canvas.
  await run("select on canvas", async () => {
    const at = await onScreen(page, targets.hover);
    const readings: Reading[] = [];
    // Each click stays selected until the page is quiet (the inspector and its export
    // preview are part of selecting); "exact" is the slowest of those.
    let after: After = { quiet: 0, longest: 0 };
    for (let i = 0; i < repeats / 2; i++) {
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(150);
      await arm(page, `(e) => e.s.selection.length > 0`);
      const t = await now(page);
      await page.mouse.down();
      readings.push(await answered(page));
      await page.mouse.up();
      const a = await quietAfter(page, t);
      after = {
        quiet: Math.max(after.quiet, a.quiet),
        longest: Math.max(after.longest, a.longest),
      };
      await select([]);
      await page.waitForTimeout(300);
    }
    return summarise(readings, 0, after);
  });

  // The inspector's export preview of the clicked layer, scrolled into view: how long the page
  // is busy drawing it (it's drawn only while it's on screen).
  // The same layer a click there selects (a board's direct child, as in Figma), clicked again.
  await run("export preview", async () => {
    const at = await onScreen(page, targets.hover);
    let after: After = { quiet: 0, longest: 0 };
    for (let i = 0; i < 2; i++) {
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(150);
      await arm(page, `(e) => e.s.selection.length > 0`);
      const t = await now(page);
      await page.mouse.click(at.x, at.y);
      await answered(page);
      const found = await page.evaluate(() => {
        const el = document.querySelector(".inspector-export");
        el?.scrollIntoView();
        return !!el;
      });
      if (!found) throw new Error("The inspector shows no Export section");
      const a = await quietAfter(page, t);
      after = {
        quiet: Math.max(after.quiet, a.quiet),
        longest: Math.max(after.longest, a.longest),
      };
      await select([]);
      await page.waitForTimeout(300);
    }
    return summarise([], 0, after);
  });

  // Clicking the moved layer's row in the layers panel.
  await run("select in layers panel", async () => {
    await select([targets.move]);
    await page.waitForTimeout(800);
    await select([]);
    await page.waitForTimeout(400);
    const row = page.locator(`.layers__scroll [data-layer-id="${targets.move}"] .dp-layer__name`);
    const box = await row.first().boundingBox();
    if (!box) throw new Error("The layer's row isn't drawn");
    const readings: Reading[] = [];
    let after: After = { quiet: 0, longest: 0 };
    for (let i = 0; i < repeats / 2; i++) {
      // The row shown selected is the answer here: the canvas follows (its frame is "content").
      await page.evaluate((id) => {
        const p = (window as unknown as { __probe: Probe }).__probe;
        const scroller = document.querySelector(".layers__scroll") as HTMLElement;
        const seen = new MutationObserver(() => {
          const el = scroller.querySelector(`[data-layer-id="${CSS.escape(id)}"]`);
          if (el?.getAttribute("aria-selected") === "true" && p.input && !p.answered) {
            seen.disconnect();
            requestAnimationFrame(() => {
              p.answered = performance.now();
            });
          }
        });
        seen.observe(scroller, {
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-selected"],
        });
      }, targets.move);
      await arm(page, `() => false`);
      const t = await now(page);
      await page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
      readings.push(await answered(page));
      const a = await quietAfter(page, t);
      after = {
        quiet: Math.max(after.quiet, a.quiet),
        longest: Math.max(after.longest, a.longest),
      };
      await select([]);
      await page.waitForTimeout(300);
    }
    return summarise(readings, 0, after);
  });

  // Dragging the layer by 12 steps of 8 px, one pointer move a frame.
  const version = `(window.drawpane ?? {}).doc?.version`;
  const changed = async () =>
    `((v) => (e) => e.doc.version !== v)(${await page.evaluate(`${version}`)})`;
  await run("drag", async () => {
    await select([targets.move]);
    await page.waitForTimeout(300);
    const at = await onScreen(page, targets.move);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const readings: Reading[] = [];
    for (let i = 1; i <= 12; i++) {
      await arm(page, await changed());
      await page.mouse.move(at.x + i * 8, at.y + i * 4);
      readings.push(await answered(page));
    }
    const t = await now(page);
    await page.mouse.up();
    const result = summarise(readings, await exactAfter(page, t), await quietAfter(page, t));
    await page.keyboard.press("Control+z");
    return result;
  });

  // Dragging as a hand does: a pointer move every frame for 60 frames, without waiting for the
  // canvas, then what the frames took (interval: what you'd see).
  await run("drag, 60 frames", async () => {
    await select([targets.move]);
    await page.waitForTimeout(300);
    const at = await onScreen(page, targets.move);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.evaluate(() => {
      const w = window as unknown as {
        drawpaneFrames: { reset(): void; record(c: number, o: number): void };
        __times?: number[];
      };
      w.drawpaneFrames.reset();
      const times: number[] = [];
      w.__times = times;
      const record = w.drawpaneFrames.record.bind(w.drawpaneFrames);
      w.drawpaneFrames.record = (c: number, o: number) => {
        record(c, o);
        times.push(performance.now());
      };
    });
    for (let i = 1; i <= 60; i++) {
      const d = i <= 30 ? i : 60 - i;
      await page.mouse.move(at.x + d * 6, at.y + d * 3);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    const summary = await page.evaluate(() => {
      const w = window as unknown as {
        drawpaneFrames: { summary(): Summary };
        __times: number[];
      };
      const gaps = w.__times
        .slice(1)
        .map((t, i) => t - (w.__times[i] as number))
        .sort((a, b) => a - b);
      const at = (q: number) =>
        Math.round((gaps[Math.floor(q * (gaps.length - 1))] ?? 0) * 10) / 10;
      return { ...w.drawpaneFrames.summary(), interval: { p50: at(0.5), p95: at(0.95) } };
    });
    await page.mouse.up();
    await settle(page);
    await page.keyboard.press("Control+z");
    return summary;
  });

  // Resizing by its bottom right handle.
  await run("resize", async () => {
    await select([targets.move]);
    await page.waitForTimeout(300);
    const at = await onScreen(page, targets.move);
    const corner = { x: at.x + at.w / 2, y: at.y + at.h / 2 };
    await page.mouse.move(corner.x, corner.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    const readings: Reading[] = [];
    for (let i = 1; i <= 12; i++) {
      await arm(page, await changed());
      await page.mouse.move(corner.x + i * 6, corner.y + i * 4);
      readings.push(await answered(page));
    }
    const t = await now(page);
    await page.mouse.up();
    const result = summarise(readings, await exactAfter(page, t), await quietAfter(page, t));
    await page.keyboard.press("Control+z");
    return result;
  });

  // Nudging with the arrow keys.
  await run("nudge", async () => {
    await select([targets.move]);
    await page.mouse.move(5, 450);
    await page.waitForTimeout(300);
    const readings: Reading[] = [];
    for (let i = 0; i < repeats; i++) {
      await arm(page, await changed());
      await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
      readings.push(await answered(page));
    }
    const t = await now(page);
    return summarise(readings, await exactAfter(page, t), await quietAfter(page, t));
  });

  // Undo, a step at a time (the nudges).
  await run("undo", async () => {
    const readings: Reading[] = [];
    for (let i = 0; i < repeats; i++) {
      await arm(page, await changed());
      await page.keyboard.press("Control+z");
      readings.push(await answered(page));
    }
    const t = await now(page);
    return summarise(readings, await exactAfter(page, t), await quietAfter(page, t));
  });

  // Typing a word at the end of a text layer.
  if (targets.text) {
    const text = targets.text;
    await run("type", async () => {
      await page.evaluate((id) => {
        const e = (
          window as unknown as {
            drawpane: {
              select(ids: string[]): void;
              startTextEdit(id: string): void;
              setTextSelection(a: number, b: number): void;
              doc: { get(id: string): { props: { characters?: string } } | undefined };
            };
          }
        ).drawpane;
        e.select([id]);
        e.startTextEdit(id);
        const n = (e.doc.get(id)?.props.characters ?? "").length;
        e.setTextSelection(n, n);
      }, text);
      const area = page.locator("textarea").first();
      await area.waitFor({ timeout: 10_000 });
      await area.focus();
      await page.waitForTimeout(500);
      const readings: Reading[] = [];
      for (const ch of " drawn".slice(0, Math.max(2, repeats - 2))) {
        await arm(page, await changed());
        await page.keyboard.press(ch === " " ? "Space" : ch);
        readings.push(await answered(page));
      }
      const t = await now(page);
      await page.keyboard.press("Escape");
      const result = summarise(readings, await exactAfter(page, t), await quietAfter(page, t));
      // Undo the typing.
      for (let i = 0; i < readings.length; i++) await page.keyboard.press("Control+z");
      return result;
    });
  }

  // A fill's colour, and a shadow's blur, as the inspector sets them (a colour drag: several steps).
  const edit = async (id: string, prop: "fills" | "effects") => {
    const readings: Reading[] = [];
    const t = await now(page);
    for (let i = 0; i < repeats / 2; i++) {
      await arm(page, await changed(), true);
      await page.evaluate(
        ({ id, prop, i }) => {
          type Paint = { type: string; color?: string };
          type Effect = { type: string; blur?: number; radius?: number };
          const e = (
            window as unknown as {
              drawpane: {
                doc: { get(id: string): { props: Record<string, unknown> } | undefined };
                setProp(ids: string[], prop: string, value: unknown): void;
              };
            }
          ).drawpane;
          const props = e.doc.get(id)?.props ?? {};
          if (prop === "fills") {
            const fills = (props.fills as Paint[]).map((f) =>
              f.type === "solid" ? { ...f, color: i % 2 ? "#3366ff" : "#ff6633" } : f,
            );
            e.setProp([id], "fills", fills);
          } else {
            const effects = (props.effects as Effect[]).map((x) =>
              x.type === "drop-shadow" || x.type === "inner-shadow"
                ? { ...x, blur: (x.blur ?? 4) + (i % 2 ? -2 : 2) }
                : x,
            );
            e.setProp([id], "effects", effects);
          }
        },
        { id, prop, i },
      );
      readings.push(await answered(page));
    }
    const result = summarise(readings, await exactAfter(page, t), await quietAfter(page, t));
    for (let i = 0; i < repeats / 2; i++) await page.keyboard.press("Control+z");
    return result;
  };
  if (targets.fill) {
    const fill = targets.fill;
    await select([fill]);
    await run("change fill", () => edit(fill, "fills"));
  }
  if (targets.effect) {
    const effect = targets.effect;
    await select([effect]);
    await run("change effect", () => edit(effect, "effects"));
  }
  await select([]);
  return out;
}

/** Shows a page whole: how long its first frame took, and until it was exact. */
export async function switchPage(page: Page, pageId: string): Promise<Answer> {
  const r = await page.evaluate(async (pageId) => {
    const w = window as unknown as {
      drawpane: { setPage(id: string): void; zoomToFit(): void };
      drawpaneFrames: { exact: boolean };
    };
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const t = performance.now();
    w.drawpane.setPage(pageId);
    w.drawpane.zoomToFit();
    await frame();
    await frame();
    const first = performance.now() - t;
    while (!w.drawpaneFrames.exact) await frame();
    return { first, exact: performance.now() - t };
  }, pageId);
  return {
    n: 1,
    answer: { p50: Math.round(r.first), max: Math.round(r.first) },
    content: { p50: 0, max: 0 },
    overlay: { p50: 0, max: 0 },
    exact: Math.round(r.exact),
    quiet: 0,
    longTask: 0,
  };
}

/** One line per case for the console. */
export function table(title: string, results: Record<string, CaseResult>): string {
  const rows = Object.entries(results).map(([name, r]) => {
    if ("answer" in r)
      return `${name.padEnd(24)} answer ${String(r.answer.p50).padStart(7)} ms (worst ${String(r.answer.max).padStart(7)}) · content ${String(r.content.p50).padStart(6)} (${r.content.max}) · overlay ${String(r.overlay.p50).padStart(5)} · exact ${String(r.exact).padStart(6)} ms · quiet ${String(r.quiet).padStart(6)} ms · long task ${r.longTask} ms · n ${r.n}`;
    return `${name.padEnd(24)} content p50 ${String(r.content.p50).padStart(6)} · p95 ${String(r.content.p95).padStart(6)} · max ${String(r.content.max).padStart(6)} ms · frame interval p50 ${r.interval?.p50} / p95 ${r.interval?.p95} ms`;
  });
  return `\n${title}\n${rows.join("\n")}`;
}

/** Profiles each case under the CPU profiler and saves it (BENCH_PROFILE). */
export function profiler(
  cdp: CDPSession,
  dir: string | undefined,
  prefix: string,
  save: (name: string, profile: unknown) => void,
): Profiler {
  if (!dir) return noProfile;
  return async (name, work) => {
    await cdp.send("Profiler.start");
    const result = await work();
    const { profile } = await cdp.send("Profiler.stop");
    save(`${prefix} ${name}`, profile);
    return result;
  };
}
