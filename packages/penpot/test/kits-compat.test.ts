/**
 * Layout compatibility against real Penpot files: every layer of every page
 * of every export in $PENPOT_KITS, converted as the import converts it, is
 * placed where Penpot placed it. Penpot records each shape's corners on the
 * page (`points`, after its own layout); the converted layer's corners must
 * match them. Off unless $PENPOT_KITS names a folder of `.penpot` files
 * (the kit store's are at github.com/penpot/penpot-files); a report of
 * every mismatch, grouped by kind, goes to $PENPOT_KITS/report-<phase>.json.
 * Every converted file must also pass the checks the server runs on an
 * import (`invalid` in the report), or adding the kit fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Doc,
  Editor,
  type FaceFileLoader,
  HarfBuzzMeasurer,
  layoutOps,
  type MeasuredFace,
  pinInstances,
  Scene,
  textFaces,
} from "@drawpane/editor";
import { applyTransaction, MemoryStore, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { convertFile, readPenpot } from "../src";

const DIR = process.env.PENPOT_KITS;
const ONLY = process.env.PENPOT_KIT;
/**
 * "open": as the editor has the file once it's open and its fonts load.
 * "relayout": as if every auto layout frame were edited, laid out again by
 * Drawpane with the text as Penpot sized it: how well the layout settings
 * came across (Penpot's stored layout can be stale, so some differ anyway).
 */
const PHASE = process.env.PENPOT_PHASE ?? "static";
const OPENED = PHASE === "open";
const RELAYOUT = PHASE === "relayout";

/**
 * Google's static TrueType file for a face, kept on disk: what the editor
 * measures with in a browser, near enough (the browser may use the
 * family's variable file, with the same metrics).
 */
const FONTS = join(DIR ?? "/tmp", "fonts");
const missingFonts = new Set<string>();
const googleFont: FaceFileLoader = async (face) => {
  const variant = `${face.italic ? 1 : 0},${Math.round(face.weight / 100) * 100}`;
  const key = `${face.family}-${variant}`.replace(/[^A-Za-z0-9,-]/g, "_");
  const file = join(FONTS, `${key}.ttf`);
  if (existsSync(file)) return new Uint8Array(readFileSync(file)).buffer;
  if (existsSync(`${file}.none`)) return null;
  mkdirSync(FONTS, { recursive: true });
  const ask = (axes: string) =>
    fetch(
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.family)}:${axes}`,
    ).then((r) => (r.ok ? r.text() : ""));
  const css =
    (await ask(`ital,wght@${variant}`)) ||
    (face.italic ? "" : await ask(`wght@${Math.round(face.weight / 100) * 100}`));
  const url = /src:\s*url\(([^)]+)\)/.exec(css)?.[1];
  const bytes = url ? await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)) : null;
  if (!bytes) {
    writeFileSync(`${file}.none`, "");
    missingFonts.add(`${face.family} ${face.weight}${face.italic ? " italic" : ""}`);
    return null;
  }
  writeFileSync(file, new Uint8Array(bytes));
  return bytes;
};
const measurer = new HarfBuzzMeasurer(googleFont);
const refitFailures: string[] = [];

/** The file as an open editor has it once its fonts have loaded. */
async function opened(nodes: ReturnType<typeof convertFile>["nodes"]): Promise<Doc> {
  const editor = new Editor({ measurer, clientId: "kits" });
  // As the import saves them (apps/web/src/dashboard/penpot-import.ts).
  editor.doc.reset(pinInstances(nodes).nodes);
  editor.state.set({ role: "editor", status: "live" });
  const faces = new Map<string, MeasuredFace>();
  for (const node of editor.doc.nodes())
    if (node.type === "text")
      for (const f of textFaces(node))
        faces.set(`${f.family}/${f.weight}/${f.italic}`, { ...f, canvas: true });
  await measurer.load([...faces.values()]);
  try {
    editor.refitText();
  } catch (error) {
    refitFailures.push((error as Error).message);
  }
  return editor.doc;
}

/** Why the server would refuse these nodes, as an import's ops (parents first), or null. */
function refusal(nodes: ReturnType<typeof convertFile>["nodes"]): string | null {
  const byParent = new Map<string, typeof nodes>();
  for (const n of nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const ops: Op[] = [];
  const queue = [...(byParent.get(ROOT_ID) ?? [])];
  for (let n = queue.shift(); n; n = queue.shift()) {
    ops.push({
      op: "create",
      id: n.id,
      type: n.type,
      parent: n.parent,
      key: n.key,
      props: n.props,
    });
    queue.push(...(byParent.get(n.id) ?? []));
  }
  if (ops.length !== nodes.length) return `${nodes.length - ops.length} layers have no parent`;
  try {
    applyTransaction(new MemoryStore([]), ops, { rollback: false });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

type Raw = Record<string, unknown>;
interface Point {
  x: number;
  y: number;
}

interface Miss {
  kit: string;
  page: string;
  id: string;
  name: string;
  type: string;
  off: number;
  context: string;
  penpot: Point[];
  drawpane: Point[] | null;
}

/** What about a shape could explain where it lands: its parent's layout, a group, a rotation… */
function contextOf(shape: Raw, shapes: ReadonlyMap<string, Raw>): string {
  const parent = shapes.get(String(shape.parentId)) as Raw | undefined;
  const tags: string[] = [];
  if (parent?.layout) tags.push(`in-${parent.layout}`);
  if (parent?.type === "group") tags.push("in-group");
  if (parent?.type === "bool") tags.push("in-bool");
  if (shape.layout) tags.push(`is-${shape.layout}`);
  const t = shape.transform as Raw | undefined;
  if (t && (Math.abs(Number(t.b ?? 0)) > 1e-6 || Math.abs(Number(t.c ?? 0)) > 1e-6))
    tags.push("rotated");
  if (t && (Number(t.a ?? 1) < 0 || Number(t.d ?? 1) < 0)) tags.push("flipped");
  if (shape.shapeRef) tags.push("copy");
  if (shape.mainInstance) tags.push("main");
  return tags.join(" ") || "plain";
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The largest distance between matching corners, in any rotation of the order (Penpot's start corner can differ). */
function cornerOff(penpot: Point[], ours: Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < 4; shift++) {
    let worst = 0;
    for (let i = 0; i < 4; i++)
      worst = Math.max(worst, dist(penpot[i] as Point, ours[(i + shift) % 4] as Point));
    best = Math.min(best, worst);
  }
  return best;
}

describe.skipIf(!DIR)("Penpot kits: layers land where Penpot put them", () => {
  it("matches every layer's corners", async () => {
    const dir = DIR as string;
    const kits = readdirSync(dir)
      .filter((f) => f.endsWith(".penpot"))
      .filter((f) => !ONLY || f.includes(ONLY))
      .sort();
    const misses: Miss[] = [];
    const totals = {
      kits: 0,
      failedKits: [] as string[],
      invalid: [] as string[],
      shapes: 0,
      missing: 0,
      off1: 0,
      off10: 0,
    };
    const byKind = new Map<string, { n: number; off1: number; off10: number }>();
    const missingKinds = new Map<string, number>();
    for (const kit of kits) {
      let exp: Awaited<ReturnType<typeof readPenpot>>;
      try {
        exp = await readPenpot(new Uint8Array(readFileSync(join(dir, kit))));
      } catch (error) {
        totals.failedKits.push(`${kit}: ${(error as Error).message}`);
        continue;
      }
      totals.kits++;
      for (const file of exp.files) {
        let nodes: ReturnType<typeof convertFile>["nodes"];
        let idOf: ReturnType<typeof convertFile>["idOf"];
        try {
          ({ nodes, idOf } = convertFile(file, () => "0".repeat(64)));
        } catch (error) {
          totals.failedKits.push(`${kit} / ${file.name}: ${(error as Error).message}`);
          continue;
        }
        const refused = refusal(nodes);
        if (refused) totals.invalid.push(`${kit} / ${file.name}: ${refused}`);
        let doc: Doc;
        if (OPENED) doc = await opened(nodes);
        else {
          doc = new Doc();
          doc.reset(RELAYOUT ? pinInstances(nodes).nodes : nodes);
          if (RELAYOUT) {
            const frames = [...doc.nodes()]
              .filter(
                (n) => n.type === "frame" && n.props.layoutMode && n.props.layoutMode !== "none",
              )
              .map((n) => n.id);
            doc.apply(layoutOps(doc, frames));
          }
        }
        const scene = new Scene(doc);
        for (const page of file.pages) {
          const shapes = page.shapes as ReadonlyMap<string, Raw>;
          for (const [id, shape] of shapes) {
            if (id === "00000000-0000-0000-0000-000000000000") continue;
            const points = shape.points as Point[] | undefined;
            if (points?.length !== 4) continue;
            totals.shapes++;
            const type = String(shape.type);
            const context = contextOf(shape, shapes);
            const kind = `${type} | ${context}`;
            const k = byKind.get(kind) ?? { n: 0, off1: 0, off10: 0 };
            k.n++;
            byKind.set(kind, k);
            const nodeId = idOf(page.record.id, id);
            const ours = doc.get(nodeId) ? scene.corners(nodeId) : null;
            if (!ours) {
              totals.missing++;
              const why = `${type} | ${context}${doc.get(nodeId) ? " (no corners)" : ""}`;
              missingKinds.set(why, (missingKinds.get(why) ?? 0) + 1);
              continue;
            }
            const off = cornerOff(points, ours);
            if (off > 1) {
              totals.off1++;
              k.off1++;
              if (off > 10) {
                totals.off10++;
                k.off10++;
              }
              misses.push({
                kit,
                page: String(page.record.name),
                id,
                name: String(shape.name),
                type,
                off: Math.round(off * 10) / 10,
                context,
                penpot: points,
                drawpane: ours,
              });
            }
          }
        }
      }
    }
    const kinds = [...byKind]
      .filter(([, v]) => v.off1 > 0)
      .sort((a, b) => b[1].off1 - a[1].off1)
      .map(([kind, v]) => ({ kind, ...v }));
    const examples = new Map<string, Miss[]>();
    for (const m of misses.sort((a, b) => b.off - a.off)) {
      const key = `${m.type} | ${m.context}`;
      const list = examples.get(key) ?? [];
      if (list.length < 5) list.push(m);
      examples.set(key, list);
    }
    writeFileSync(
      join(dir, `misses-${PHASE}.jsonl`),
      misses.map((m) => JSON.stringify(m)).join("\n"),
    );
    writeFileSync(
      join(dir, `report-${PHASE}.json`),
      JSON.stringify(
        {
          totals,
          kinds,
          missingKinds: Object.fromEntries([...missingKinds].sort((a, b) => b[1] - a[1])),
          missingFonts: [...missingFonts],
          refitFailures,
          examples: Object.fromEntries(examples),
        },
        null,
        1,
      ),
    );
    console.log(JSON.stringify({ ...totals, refitFailures: refitFailures.length }, null, 1));
    console.table(kinds.slice(0, 40));
    expect(totals.kits).toBeGreaterThan(0);
    expect(totals.invalid).toEqual([]);
  }, 3_600_000);
});
