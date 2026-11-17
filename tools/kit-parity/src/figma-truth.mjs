// Figma's side of the comparison, from Figma in a browser with its plugin
// API (tools/figma-parity/figma-session.mjs): for each sampled frame, a PNG
// from Figma's own exporter (not the rationed REST image API) and its node
// tree as Figma lays it out.
//
// Resumable: a frame whose PNG and tree are both saved is skipped, so an
// interrupted run picks up where it stopped. One frame at a time, with a
// pause between, and a fresh session when one fails.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileChanged, withFigma } from "./figma-session.mjs";

/** A Figma id as a file name: "I1:2;3:4" → "I1-2_3-4". */
export const fileSafe = (id) => id.replace(/:/g, "-").replace(/;/g, "_");

/**
 * Runs in the Figma page: exports one node and walks its tree. Everything
 * Figma decides about layout is read back as it stands: absolute boxes,
 * render bounds, and for text the fonts and whether Figma has them.
 */
async function exportInFigma({ id, scale }) {
  const figma = window.figma;
  const node = await figma.getNodeByIdAsync(id);
  if (!node) return { missing: true };
  const round = (v) => Math.round(v * 1000) / 1000;
  const box = (r) =>
    r ? { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) } : null;
  const nodes = [];
  const fonts = new Set();
  let missingFonts = 0;
  const walk = (n, parent, depth) => {
    const out = {
      id: n.id,
      parent,
      depth,
      name: n.name,
      type: n.type,
      visible: n.visible,
      box: box(n.absoluteBoundingBox),
      render: "absoluteRenderBounds" in n ? box(n.absoluteRenderBounds) : null,
    };
    if ("rotation" in n && n.rotation) out.rotation = round(n.rotation);
    if ("layoutMode" in n && n.layoutMode !== "NONE") out.layoutMode = n.layoutMode;
    if ("layoutSizingHorizontal" in n && parent !== null) {
      out.sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical];
    }
    if ("layoutPositioning" in n && n.layoutPositioning === "ABSOLUTE") out.absolute = true;
    if ("clipsContent" in n && n.clipsContent) out.clips = true;
    if (n.type === "TEXT") {
      const segments = n.getStyledTextSegments(["fontName", "fontSize", "lineHeight"]);
      out.text = {
        chars: n.characters.length,
        autoResize: n.textAutoResize,
        missingFont: n.hasMissingFont,
        fonts: [...new Set(segments.map((s) => `${s.fontName.family}/${s.fontName.style}`))],
        sizes: [...new Set(segments.map((s) => s.fontSize))],
      };
      for (const f of out.text.fonts) fonts.add(f);
      if (n.hasMissingFont) missingFonts++;
    }
    nodes.push(out);
    if ("children" in n) for (const c of n.children) walk(c, n.id, depth + 1);
  };
  walk(node, null, 0);
  const started = performance.now();
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
    // The node's own box, as Drawpane draws it: not grown to shadows, not cut to content.
    useAbsoluteBounds: true,
  });
  const exportMs = Math.round(performance.now() - started);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  let pageId = null;
  for (let p = node.parent; p; p = p.parent) if (p.type === "PAGE") pageId = p.id;
  return {
    tree: {
      id: node.id,
      name: node.name,
      type: node.type,
      pageId,
      box: box(node.absoluteBoundingBox),
      render: "absoluteRenderBounds" in node ? box(node.absoluteRenderBounds) : null,
      scale,
      fonts: [...fonts].sort(),
      missingFonts,
      exportMs,
      nodes,
    },
    png: btoa(s),
  };
}

/** PNG size from its header. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Saves Figma's truth for every sampled frame not saved yet. `link` opens
 * the Figma file; `out` holds sample.json and gets figma/.
 */
export async function figmaTruth({ link, out, only = null, limit = Infinity, log = console.log }) {
  const sample = JSON.parse(readFileSync(join(out, "sample.json"), "utf8"));
  const dir = join(out, "figma");
  mkdirSync(dir, { recursive: true });
  const failedFile = join(dir, "failed.json");
  const failed = existsSync(failedFile) ? JSON.parse(readFileSync(failedFile, "utf8")) : {};
  const done = (f) =>
    existsSync(join(dir, `${fileSafe(f.id)}.png`)) &&
    existsSync(join(dir, `${fileSafe(f.id)}.json`));
  // At most `limit` frames this run, however many sessions it takes.
  const chosen = sample.frames
    .filter((f) => !only || only.includes(f.id))
    .filter((f) => !done(f))
    .slice(0, limit);
  const todo = () => chosen.filter((f) => !done(f) && (failed[f.id]?.attempts ?? 0) < 2);
  const scale = sample.createdWith?.scale ?? 2;
  let saved = 0;
  for (let session = 0; todo().length > 0 && session < 6; session++) {
    if (session > 0) {
      log(`Starting a new Figma session (${todo().length} frames left) in 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
    try {
      await withFigma(link, async (page, guard) => {
        let currentPage = null;
        for (const frame of todo()) {
          if (frame.pageId !== currentPage) {
            // Figma loads a page's content before its nodes export.
            await page.evaluate(async (pageId) => {
              const target = await window.figma.getNodeByIdAsync(pageId);
              await window.figma.setCurrentPageAsync(target);
              window.__kitParityWatch(target);
            }, frame.pageId);
            currentPage = frame.pageId;
          }
          const started = Date.now();
          let result;
          try {
            result = await page.evaluate(exportInFigma, { id: frame.id, scale });
          } catch (error) {
            // The page itself may be gone; count it against the frame and let the session restart.
            const attempts = (failed[frame.id]?.attempts ?? 0) + 1;
            failed[frame.id] = { attempts, error: String(error?.message ?? error).split("\n")[0] };
            writeFileSync(failedFile, `${JSON.stringify(failed, null, 2)}\n`);
            throw error;
          }
          if (result.missing) {
            failed[frame.id] = { attempts: 2, error: "No node with this id in the Figma file." };
            writeFileSync(failedFile, `${JSON.stringify(failed, null, 2)}\n`);
            log(`  ${frame.id}: not in the Figma file`);
            continue;
          }
          const png = Buffer.from(result.png, "base64");
          const tree = { ...result.tree, png: pngSize(png) };
          // The sample's id came from the .fig: Figma's node must be the same node.
          tree.matchesSample = tree.name === frame.name && tree.pageId === frame.pageId;
          const base = join(dir, fileSafe(frame.id));
          writeFileSync(`${base}.png.tmp`, png);
          writeFileSync(`${base}.json.tmp`, JSON.stringify(tree));
          renameSync(`${base}.png.tmp`, `${base}.png`);
          renameSync(`${base}.json.tmp`, `${base}.json`);
          await guard.assertUnchanged();
          delete failed[frame.id];
          saved++;
          log(
            `  ${frame.id} ${tree.png.width}×${tree.png.height}, ${tree.nodes.length} nodes, ${Date.now() - started} ms${tree.matchesSample ? "" : " (NOT the sampled node)"}`,
          );
          // Gently: Figma is a shared service.
          await new Promise((r) => setTimeout(r, 200));
        }
      });
    } catch (error) {
      if (error instanceof FileChanged) throw error;
      log(`Figma session failed: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
  const left = todo().length;
  const gaveUp = Object.keys(failed).length;
  log(`Saved ${saved} frames from Figma; ${left} left to do, ${gaveUp} failed (${failedFile}).`);
  return { saved, left, failed: gaveUp };
}
