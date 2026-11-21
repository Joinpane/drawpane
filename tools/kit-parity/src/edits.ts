/**
 * Times the editor's edit pipeline on a converted kit, headless: the same
 * edits the interaction bench makes (drag, nudge, undo, a fill, typing) on
 * the busiest board of a page, through `Editor` and `Interaction` as the
 * browser drives them, with copies stored compact as a room stores them.
 * No renderer, no React: what's left is the model, copies, variables,
 * layout, history and sync's bookkeeping.
 */

import { existsSync, writeFileSync } from "node:fs";
import { Editor, Interaction, type PointerInput, type TextMeasurer } from "@drawpane/editor";
import { compactByInstance, getProp, type NodeRecord } from "@drawpane/model";
import { readNodes } from "./detach";

/** Every character is 0.55 of the font size wide: deterministic, and cheap like a warm cache. */
const measurer: TextMeasurer = {
  width: (font, text) => {
    const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16);
    return text.length * size * 0.55;
  },
};

const at = (x: number, y: number): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks: 1,
});

export interface CaseTimes {
  /** Each step's time in ms. */
  readonly steps: number[];
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly total: number;
}

function summary(steps: number[]): CaseTimes {
  const sorted = [...steps].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    steps: steps.map(r),
    p50: r(q(0.5)),
    p95: r(q(0.95)),
    max: r(sorted.at(-1) ?? 0),
    total: r(steps.reduce((a, b) => a + b, 0)),
  };
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

export interface EditsOptions {
  readonly pages?: readonly string[];
  readonly frames?: number;
  readonly repeats?: number;
  /** Which cases to run (all when empty). */
  readonly only?: readonly string[];
  /** Called between cases, e.g. to start and stop a profiler. */
  readonly around?: (name: string, work: () => void) => void;
}

export function loadEditor(
  path: string,
  { cache }: { readonly cache?: string } = {},
): { editor: Editor; seconds: Record<string, number> } {
  const seconds: Record<string, number> = {};
  let t = performance.now();
  let stored: NodeRecord[];
  if (cache && existsSync(cache)) {
    stored = readNodes(cache);
    seconds.read = (performance.now() - t) / 1000;
  } else {
    const nodes = readNodes(path);
    seconds.read = (performance.now() - t) / 1000;
    t = performance.now();
    stored = compactByInstance(nodes).nodes;
    seconds.compact = (performance.now() - t) / 1000;
    if (cache) writeFileSync(cache, `${stored.map((n) => JSON.stringify(n)).join("\n")}\n`);
  }
  t = performance.now();
  const editor = new Editor({ measurer, clientId: "bench" });
  editor.state.set({ role: "editor", viewport: { width: 1440, height: 900 } });
  editor.doc.resetStored(stored, "compact");
  seconds.load = (performance.now() - t) / 1000;
  // The browser builds every copy as the file opens (the font scan, the backdrop readers).
  t = performance.now();
  let presented = 0;
  for (const _ of editor.doc.nodes()) presented++;
  seconds.buildAll = (performance.now() - t) / 1000;
  seconds.presented = presented;
  return { editor, seconds };
}

/** The top-level layer with the most effects under it, as the browser bench picks it. */
function busiestBoard(editor: Editor, pageId: string): string {
  const doc = editor.doc;
  const weight = (id: string): number => {
    const n = doc.get(id);
    let w = 0;
    for (const x of (n?.props.effects as Array<{ type: string }> | undefined) ?? [])
      w += x.type === "glass" || x.type === "background-blur" ? 4 : 1;
    for (const c of doc.childIds(id)) w += weight(c);
    return w;
  };
  return [...doc.childIds(pageId)].sort((a, b) => weight(b) - weight(a))[0] as string;
}

/** The interaction bench's targets (`pickTargets`). */
function pickTargets(editor: Editor, board: string) {
  const doc = editor.doc;
  const all: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const c of doc.childIds(id)) {
      const n = doc.get(c);
      if (!n || n.props.visible === false) continue;
      all.push(n);
      walk(c);
    }
  };
  walk(board);
  const effects = (n: NodeRecord) =>
    ((n.props.effects as Array<{ type: string; visible?: boolean }> | undefined) ?? []).filter(
      (x) => x.visible !== false,
    );
  const size = (n: NodeRecord) => {
    const b = editor.scene.bounds(n.id);
    return b ? { w: b.width, h: b.height, area: b.width * b.height } : null;
  };
  const fits = (n: NodeRecord) => {
    const s = size(n);
    return !!s && s.w >= 40 && s.h >= 40 && s.w <= 480 && s.h <= 480;
  };
  const largest = (list: NodeRecord[]) =>
    list.sort((a, b) => (size(b)?.area ?? 0) - (size(a)?.area ?? 0))[0] ?? null;
  const readers = all.filter(
    (n) => fits(n) && effects(n).some((x) => x.type === "glass" || x.type === "background-blur"),
  );
  const move = largest(readers) ?? largest(all.filter(fits)) ?? doc.get(board);
  const texts = all.filter((n) => n.type === "text");
  const glyphs = (n: NodeRecord) =>
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
  return { board, move: (move as NodeRecord).id, text: text?.id ?? null, fill: fill?.id ?? null };
}

export function runEdits(editor: Editor, options: EditsOptions = {}) {
  const { frames = 60, repeats = 8, only = [], around = (_n, w) => w() } = options;
  const want = (name: string) => only.length === 0 || only.includes(name);
  const doc = editor.doc;
  const ix = new Interaction(editor);
  const out: Record<string, unknown> = {};
  const pages = doc.pageIds().filter((id) => {
    const name = getProp(doc.get(id)?.props ?? {}, "name");
    return !options.pages || options.pages.includes(name) || options.pages.includes(id);
  });
  for (const pageId of pages) {
    const name = getProp(doc.get(pageId)?.props ?? {}, "name");
    const results: Record<string, unknown> = {};
    results["switch page"] = time(() => editor.setPage(pageId));
    const board = busiestBoard(editor, pageId);
    const targets = pickTargets(editor, board);
    results.targets = targets;
    const versionBefore = doc.version;

    const center = (id: string) => {
      editor.zoomToLayers([board]);
      const b = editor.scene.bounds(id);
      if (!b) throw new Error(`No bounds for ${id}`);
      return editor.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    };

    if (want("drag")) {
      editor.select([targets.move]);
      const p = center(targets.move);
      const steps: number[] = [];
      let up = 0;
      around(`${name}: drag ${frames} frames`, () => {
        ix.down(at(p.x, p.y));
        for (let i = 1; i <= frames; i++)
          steps.push(time(() => ix.move(at(p.x + i * 4, p.y + i * 2))));
        up = time(() => ix.up(at(p.x + frames * 4, p.y + frames * 2)));
      });
      results[`drag ${frames} frames`] = { ...summary(steps), up };
      results["undo drag"] = time(() => editor.undo());
    }

    if (want("resize")) {
      // By the bottom right corner of its box on screen, as the interaction bench does.
      editor.select([targets.move]);
      center(targets.move);
      const corners = (editor.scene.corners(targets.move) ?? []).map((c) =>
        editor.s.camera.toScreen(c),
      );
      const corner = {
        x: Math.max(...corners.map((c) => c.x)),
        y: Math.max(...corners.map((c) => c.y)),
      };
      const steps: number[] = [];
      const before = doc.version;
      let handle: string | null = null;
      around(`${name}: resize`, () => {
        handle = ix.handleAt(corner)?.handle ?? null;
        ix.down(at(corner.x, corner.y));
        for (let i = 1; i <= 12; i++)
          steps.push(time(() => ix.move(at(corner.x + i * 6, corner.y + i * 4))));
        ix.up(at(corner.x + 72, corner.y + 48));
      });
      results.resize = { ...summary(steps), handle, changed: doc.version !== before };
      if (doc.version !== before) results["undo resize"] = time(() => editor.undo());
    }

    if (want("nudge")) {
      editor.select([targets.move]);
      const steps: number[] = [];
      const undos: number[] = [];
      around(`${name}: nudge`, () => {
        for (let i = 0; i < repeats; i++) steps.push(time(() => editor.nudge(1, 0)));
      });
      results.nudge = summary(steps);
      around(`${name}: undo`, () => {
        for (let i = 0; i < repeats; i++) undos.push(time(() => editor.undo()));
      });
      results.undo = summary(undos);
    }

    if (want("fill") && targets.fill) {
      const id = targets.fill;
      editor.select([id]);
      const steps: number[] = [];
      around(`${name}: change fill`, () => {
        editor.beginGesture("Fill");
        for (let i = 0; i < repeats; i++) {
          const fills = (getProp(doc.get(id)?.props ?? {}, "fills") as Array<{ type: string }>).map(
            (f) => (f.type === "solid" ? { ...f, color: i % 2 ? "#3366ff" : "#ff6633" } : f),
          );
          steps.push(time(() => editor.setProp([id], "fills", fills)));
        }
        editor.endGesture();
      });
      results["change fill"] = summary(steps);
      results["undo fill"] = time(() => editor.undo());
    }

    if (want("type") && targets.text) {
      const id = targets.text;
      const steps: number[] = [];
      around(`${name}: type`, () => {
        editor.startTextEdit(id);
        let chars = getProp(doc.get(id)?.props ?? {}, "characters");
        for (const ch of "Hello wor") {
          chars += ch;
          editor.setTextSelection(chars.length - 1, chars.length - 1);
          const c = chars;
          steps.push(time(() => editor.updateText(id, c, c.length)));
        }
        editor.endTextEdit();
      });
      results.type = summary(steps);
      results["undo type"] = time(() => editor.undo());
    }

    results.versions = doc.version - versionBefore;
    out[name] = results;
  }
  return out;
}

/** The results as a Markdown table: each edit's median, p95 and worst step, in ms. */
export function editsTable(results: Record<string, Record<string, unknown>>): string {
  const lines = ["| page | edit | p50 ms | p95 ms | worst ms |", "| --- | --- | --- | --- | --- |"];
  for (const [page, cases] of Object.entries(results))
    for (const [name, value] of Object.entries(cases)) {
      if (typeof value === "number" && name !== "versions")
        lines.push(`| ${page} | ${name} | ${value.toFixed(1)} | | |`);
      else if (value && typeof value === "object" && "p50" in value) {
        const t = value as CaseTimes & { up?: number };
        lines.push(`| ${page} | ${name} | ${t.p50} | ${t.p95} | ${t.max} |`);
        if (t.up !== undefined) lines.push(`| ${page} | drop | ${t.up.toFixed(1)} | | |`);
      }
    }
  return lines.join("\n");
}
