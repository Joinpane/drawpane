/**
 * A run's scoreboard and its HTML report: every frame, worst first, with
 * Figma's render, Drawpane's and where they differ side by side, and the
 * layout deltas under each.
 */
import type { Delta, LayoutDiff } from "./layout-diff";

export interface FrameScore {
  readonly id: string;
  readonly name: string;
  readonly pageName: string;
  readonly kind: string;
  readonly width: number;
  readonly height: number;
  /** Mean difference over RGB, 0 to 255, both sides over white. */
  readonly mean: number;
  /** 99th percentile of the per-pixel difference (max over RGB). */
  readonly p99: number;
  /** Share of pixels more than 32 apart, 0 to 1. */
  readonly changed: number;
  readonly figmaMissingFonts: number;
  readonly drawpaneMissingFonts: readonly string[];
  readonly layout: LayoutDiff;
  /** File names, relative to the run folder. */
  readonly images: { readonly figma: string; readonly drawpane: string; readonly heat: string };
}

export interface Summary {
  readonly frames: number;
  readonly median: number;
  readonly p90: number;
  readonly mean: number;
  readonly over: Record<string, number>;
  readonly layout: {
    readonly missing: number;
    readonly extra: number;
    readonly byPlace: number;
    readonly flattened: number;
    readonly visibility: number;
    readonly moved: number;
    readonly resized: number;
    readonly text: number;
  };
}

export const THRESHOLDS = [1, 2, 5, 10, 20];

const quantile = (sorted: readonly number[], q: number) =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number);

export function summarize(frames: readonly FrameScore[]): Summary {
  const means = frames.map((f) => f.mean).sort((a, b) => a - b);
  const sum = (pick: (l: LayoutDiff) => number) => frames.reduce((a, f) => a + pick(f.layout), 0);
  return {
    frames: frames.length,
    median: quantile(means, 0.5),
    p90: quantile(means, 0.9),
    mean: Math.round((means.reduce((a, b) => a + b, 0) / Math.max(1, means.length)) * 100) / 100,
    over: Object.fromEntries(THRESHOLDS.map((t) => [`>${t}`, means.filter((m) => m > t).length])),
    layout: {
      missing: sum((l) => l.missing.length),
      extra: sum((l) => l.extra.length),
      byPlace: sum((l) => l.byPlace.length),
      flattened: sum((l) => l.flattened),
      visibility: sum((l) => l.visibility.length),
      moved: sum((l) => l.moved.length),
      resized: sum((l) => l.resized.length),
      text: sum((l) => l.text.length),
    },
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function deltas(title: string, list: readonly Delta[], limit = 25): string {
  if (list.length === 0) return "";
  const rows = list
    .slice(0, limit)
    .map(
      (d) =>
        `<tr><td><code>${esc(d.id)}</code></td><td>${esc(d.type)}</td><td>${esc(d.name)}</td><td>${d.dx}</td><td>${d.dy}</td><td>${d.dw}</td><td>${d.dh}</td></tr>`,
    )
    .join("");
  return `<h4>${title} (${list.length})</h4><table class="d"><tr><th>Figma id</th><th>type</th><th>name</th><th>dx</th><th>dy</th><th>dw</th><th>dh</th></tr>${rows}</table>${list.length > limit ? `<p>… ${list.length - limit} more in scoreboard.json</p>` : ""}`;
}

export function reportHtml(
  title: string,
  meta: Record<string, unknown>,
  summary: Summary,
  frames: readonly FrameScore[],
  /** Each frame's score in the run compared against, when there is one. */
  was?: ReadonlyMap<string, number>,
): string {
  const change = (f: FrameScore) => {
    const before = was?.get(f.id);
    if (before === undefined) return "";
    const d = Math.round((f.mean - before) * 100) / 100;
    return d === 0 ? " (same)" : ` (was ${before}, ${d > 0 ? "+" : ""}${d})`;
  };
  const worst = [...frames].sort((a, b) => b.mean - a.mean);
  const rows = worst
    .map((f, i) => {
      const l = f.layout;
      const flags = [
        f.drawpaneMissingFonts.length
          ? `<b class="bad">missing fonts: ${esc(f.drawpaneMissingFonts.join(", "))}</b>`
          : "",
        f.figmaMissingFonts
          ? `<b class="bad">Figma lacks fonts for ${f.figmaMissingFonts} text layers</b>`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const lists = [
        deltas("Moved (relative to parent)", l.moved),
        deltas("Resized", l.resized),
        deltas("Text boxes", l.text),
        l.visibility.length
          ? `<h4>Visibility (${l.visibility.length})</h4><p>${l.visibility
              .slice(0, 25)
              .map(
                (v) =>
                  `<code>${esc(v.id)}</code> Figma ${v.figma ? "shown" : "hidden"}, Drawpane ${v.drawpane ? "shown" : "hidden"}`,
              )
              .join("<br>")}</p>`
          : "",
        l.missing.length
          ? `<h4>Missing in Drawpane (${l.missing.length})</h4><p>${l.missing
              .slice(0, 25)
              .map((m) => `<code>${esc(m.id)}</code> ${esc(m.type)} ${esc(m.name)}`)
              .join("<br>")}</p>`
          : "",
        l.extra.length
          ? `<h4>Only in Drawpane (${l.extra.length})</h4><p>${l.extra
              .slice(0, 25)
              .map((m) => `<code>${esc(m.id)}</code> ${esc(m.type)}`)
              .join("<br>")}</p>`
          : "",
      ].join("");
      const img = (src: string) =>
        `<a href="${esc(src)}" target="_blank"><img loading="lazy" src="${esc(src)}"></a>`;
      return `<section id="f${i}"><h3>#${i + 1} ${esc(f.name)} <small><code>${esc(f.id)}</code> · ${esc(f.pageName)} · ${f.kind} · ${f.width}×${f.height}</small></h3>
<p class="score">mean <b>${f.mean}</b>${change(f)} · p99 ${f.p99} · ${(f.changed * 100).toFixed(1)}% of pixels off · layout: ${l.moved.length} moved, ${l.resized.length} resized, ${l.text.length} text, ${l.visibility.length} visibility, ${l.missing.length} missing (${l.flattened} flattened), ${l.extra.length} extra, ${l.byPlace.length} matched by place (ids differ) ${flags}</p>
<div class="row"><figure>${img(f.images.figma)}<figcaption>Figma</figcaption></figure><figure>${img(f.images.drawpane)}<figcaption>Drawpane</figcaption></figure><figure>${img(f.images.heat)}<figcaption>Difference</figcaption></figure></div>
${lists ? `<details><summary>Layout deltas</summary>${lists}</details>` : ""}</section>`;
    })
    .join("\n");
  const index = worst
    .map(
      (f, i) =>
        `<tr><td><a href="#f${i}">${i + 1}</a></td><td>${f.mean}${change(f)}</td><td>${f.p99}</td><td>${esc(f.name)}</td><td><code>${esc(f.id)}</code></td><td>${esc(f.pageName)}</td><td>${f.kind}</td><td>${f.layout.moved.length}/${f.layout.resized.length}/${f.layout.text.length}/${f.layout.missing.length}</td></tr>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f5f1;--fg:#1d1d1b;--muted:#6b6a65;--card:#fff;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9a998f;--card:#21211f;--bad:#ff8a80}}
body{font:13px/1.45 system-ui,sans-serif;margin:24px;background:var(--bg);color:var(--fg)}
small,figcaption,.muted{color:var(--muted)}section{background:var(--card);padding:12px 16px;margin:16px 0;border-radius:8px}
.row{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;flex:1 1 280px;min-width:0}img{max-width:100%;max-height:520px;display:block;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
table{border-collapse:collapse}td,th{padding:2px 8px;text-align:left;vertical-align:top}.bad{color:var(--bad)}code{font-size:12px}
</style>
<h1>${esc(title)}</h1>
<p>Figma's render of each sampled frame (its own exporter, 2×) against Drawpane's (the canvas renderer, 2×, the same page rect), both over white. Mean is the mean difference over RGB, 0 to 255; p99 its 99th percentile per pixel. Layout deltas are Drawpane minus Figma, in px, past 0.5.</p>
<pre>${esc(JSON.stringify({ ...meta, summary }, null, 2))}</pre>
<table><tr><th>#</th><th>mean</th><th>p99</th><th>name</th><th>id</th><th>page</th><th>kind</th><th>moved/resized/text/missing</th></tr>${index}</table>
${rows}`;
}
