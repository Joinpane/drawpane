/**
 * Text widths, Figma's against Drawpane's, per font: for every text layer
 * of a run's frames, the width Figma saved for it (its box, as Figma laid
 * it out) against the width Drawpane measures for the same characters
 * (the widest line unwrapped, from the run's layout), and the face each
 * side draws it in.
 *
 * Auto-width text is where the two can be compared directly: Figma's box
 * is the text's own width, rounded up to a whole pixel, as Drawpane rounds
 * its own. When Drawpane measures wider, a hug-sized button or chip keeps
 * Figma's width and the text is cut or wraps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drawpaneId } from "@drawpane/figma";
import type { DrawpaneNode, FigmaNode } from "./layout-diff";

const fileSafe = (id: string) => id.replace(/:/g, "-").replace(/;/g, "_");

export interface FontWidths {
  /** Figma's face and size ("Inter/Medium 14"). */
  readonly font: string;
  /** Auto-width text layers compared. */
  readonly layers: number;
  /** Median and mean of Drawpane's width (rounded up) minus Figma's, px. */
  readonly median: number;
  readonly mean: number;
  /** Median of Drawpane's unrounded width over Figma's box. */
  readonly ratio: number;
  /** Share Drawpane measures wider than Figma's box, by more than half a pixel (cut or wrapped). */
  readonly wider: number;
  readonly narrower: number;
  readonly worst: { readonly id: string; readonly figma: number; readonly drawpane: number } | null;
  /** The faces Drawpane drew it in, by how many layers. */
  readonly drawnIn: Readonly<Record<string, number>>;
}

export interface TextWidths {
  readonly frames: number;
  readonly textLayers: number;
  /** Text layers whose face differs: Figma's face → Drawpane's → layers. */
  readonly faces: readonly { figma: string; drawpane: string; layers: number }[];
  readonly fonts: readonly FontWidths[];
}

interface DrawnFrame {
  readonly nodes: readonly DrawpaneNode[];
}
interface FigmaFrame {
  readonly nodes: readonly FigmaNode[];
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Figma's "Semi Bold" style as the weight Drawpane spells in faces ("Inter/600"). */
const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/, 100],
  [/extra ?light|ultra ?light/, 200],
  [/light/, 300],
  [/medium/, 500],
  [/semi ?bold|demi ?bold/, 600],
  [/extra ?bold|ultra ?bold/, 800],
  [/bold/, 700],
  [/black|heavy/, 900],
];
export function drawpaneFace(figmaFont: string): string {
  const slash = figmaFont.lastIndexOf("/");
  const family = figmaFont.slice(0, slash);
  const style = figmaFont.slice(slash + 1).toLowerCase();
  const weight = WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;
  return `${family}/${weight}${/italic|oblique/.test(style) ? "i" : ""}`;
}

/** Text widths over a run's frames (all of them, or the sample's frames `only` names). */
export function textWidths(out: string, run: string, only?: ReadonlySet<string>): TextWidths {
  const sample = JSON.parse(readFileSync(join(out, "sample.json"), "utf8")) as {
    frames: { id: string }[];
  };
  type Entry = {
    diffs: number[];
    ratios: number[];
    worst: FontWidths["worst"];
    drawn: Map<string, number>;
  };
  const perFont = new Map<string, Entry>();
  const faces = new Map<string, number>();
  let frames = 0;
  let textLayers = 0;
  const seen = new Set<string>();
  for (const frame of sample.frames) {
    if (only && !only.has(frame.id)) continue;
    const figmaFile = join(out, "figma", `${fileSafe(frame.id)}.json`);
    const drawnFile = join(run, "drawpane", `${fileSafe(frame.id)}.json`);
    if (!existsSync(figmaFile) || !existsSync(drawnFile)) continue;
    frames++;
    const figma = JSON.parse(readFileSync(figmaFile, "utf8")) as FigmaFrame;
    const drawn = JSON.parse(readFileSync(drawnFile, "utf8")) as DrawnFrame;
    const ours = new Map(drawn.nodes.map((n) => [n.id, n]));
    for (const n of figma.nodes) {
      // Frames overlap (a board and its cards): each layer once.
      if (!n.text || !n.box || seen.has(n.id)) continue;
      const d = ours.get(drawpaneId(n.id));
      if (!d?.text || !n.visible) continue;
      seen.add(n.id);
      textLayers++;
      const theirs = n.text.fonts;
      if (theirs.length !== 1) continue;
      const figmaFont = theirs[0] as string;
      const face = drawpaneFace(figmaFont);
      const drawnFace = d.faces?.[0] ?? "?";
      if (drawnFace !== face) {
        const key = `${figmaFont}\u0000${drawnFace}`;
        faces.set(key, (faces.get(key) ?? 0) + 1);
      }
      const size = n.text.sizes?.length === 1 ? ` ${n.text.sizes[0]}` : "";
      const font = `${figmaFont}${size}`;
      if (n.text.autoResize === "WIDTH_AND_HEIGHT") {
        const entry: Entry = perFont.get(font) ?? {
          diffs: [],
          ratios: [],
          worst: null,
          drawn: new Map(),
        };
        const figmaWidth = n.box.width;
        const diff = Math.ceil(d.text.width - 0.001) - figmaWidth;
        entry.diffs.push(diff);
        if (figmaWidth > 0) entry.ratios.push(d.text.width / figmaWidth);
        if (!entry.worst || Math.abs(diff) > Math.abs(entry.worst.drawpane - entry.worst.figma))
          entry.worst = { id: n.id, figma: r2(figmaWidth), drawpane: r2(d.text.width) };
        entry.drawn.set(drawnFace, (entry.drawn.get(drawnFace) ?? 0) + 1);
        perFont.set(font, entry);
      }
    }
  }
  const fonts: FontWidths[] = [...perFont]
    .map(([font, e]) => ({
      font,
      layers: e.diffs.length,
      median: r2(median(e.diffs)),
      mean: r2(e.diffs.reduce((a, b) => a + b, 0) / e.diffs.length),
      ratio: Math.round(median(e.ratios) * 10000) / 10000,
      wider: r2(e.diffs.filter((x) => x > 0.5).length / e.diffs.length),
      narrower: r2(e.diffs.filter((x) => x < -0.5).length / e.diffs.length),
      worst: e.worst,
      drawnIn: Object.fromEntries(e.drawn),
    }))
    .sort((a, b) => b.layers * b.wider - a.layers * a.wider || b.layers - a.layers);
  return {
    frames,
    textLayers,
    faces: [...faces]
      .map(([k, layers]) => {
        const [figma = "", drawpane = ""] = k.split("\u0000");
        return { figma, drawpane, layers };
      })
      .sort((a, b) => b.layers - a.layers),
    fonts,
  };
}

export function textWidthsMarkdown(t: TextWidths): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `${t.frames} frames, ${t.textLayers} text layers.`,
    "",
    "Auto-width text: Drawpane's measured width (rounded up) against Figma's box.",
    "",
    "| Figma font | Layers | Median Δ px | Mean Δ px | Width ratio | Wider | Narrower | Drawn in | Worst (Figma → Drawpane) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...t.fonts.map(
      (f) =>
        `| ${f.font} | ${f.layers} | ${f.median} | ${f.mean} | ${f.ratio} | ${pct(f.wider)} | ${pct(f.narrower)} | ${Object.entries(
          f.drawnIn,
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(
            ", ",
          )} | ${f.worst ? `\`${f.worst.id}\` ${f.worst.figma} → ${f.worst.drawpane}` : ""} |`,
    ),
    "",
    ...(t.faces.length > 0
      ? [
          "Faces that differ (Figma's face, the face Drawpane drew):",
          "",
          "| Figma | Drawpane | Layers |",
          "| --- | --- | --- |",
          ...t.faces.map((f) => `| ${f.figma} | ${f.drawpane} | ${f.layers} |`),
          "",
        ]
      : ["Every text layer is drawn in Figma's face.", ""]),
  ].join("\n");
}
