/**
 * A converted file's pages (the folder kit-parity's convert step writes),
 * heaviest first by the effects that cost the most to draw: layers that
 * read the backdrop (glass, background blur), then shadows. Shared by the
 * file benchmarks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Effects {
  layers: number;
  readers: number;
  shadows: number;
  blurs: number;
}

export interface PageInfo extends Effects {
  id: string;
  name: string;
  /** The top-level layer with the most effects under it: where the close-up pans are. */
  busiest: string | null;
}

/** Each page's layers and effects, from the converted nodes, heaviest first. */
export function pagesOf(folder: string): PageInfo[] {
  type Node = {
    id: string;
    type: string;
    parent: string;
    props?: { name?: string; effects?: Array<{ type: string; visible?: boolean }> };
  };
  const nodes: Node[] = [];
  // Split on "\n" only: text may hold "\r".
  for (const line of readFileSync(join(folder, "nodes.ndjson"), "utf8").split("\n"))
    if (line) nodes.push(JSON.parse(line) as Node);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pages = new Map<string, PageInfo>();
  const tops = new Map<string, number>();
  for (const n of nodes)
    if (n.type === "page")
      pages.set(n.id, {
        id: n.id,
        name: n.props?.name ?? n.id,
        layers: 0,
        readers: 0,
        shadows: 0,
        blurs: 0,
        busiest: null,
      });
  for (const n of nodes) {
    if (n.type === "page") continue;
    let top = n;
    let at = byId.get(n.parent);
    while (at && at.type !== "page") {
      top = at;
      at = byId.get(at.parent);
    }
    const page = at && pages.get(at.id);
    if (!page) continue;
    page.layers++;
    let weight = 0;
    for (const e of n.props?.effects ?? []) {
      if (e.visible === false) continue;
      if (e.type === "glass" || e.type === "background-blur") {
        page.readers++;
        weight += 4;
      } else if (e.type === "drop-shadow" || e.type === "inner-shadow") {
        page.shadows++;
        weight += 1;
      } else if (e.type === "layer-blur") {
        page.blurs++;
        weight += 2;
      }
    }
    if (weight > 0) tops.set(top.id, (tops.get(top.id) ?? 0) + weight);
  }
  for (const [id, weight] of tops) {
    const page = pages.get(byId.get(id)?.parent ?? "");
    if (page && (page.busiest === null || weight > (tops.get(page.busiest) ?? 0)))
      page.busiest = id;
  }
  return [...pages.values()].sort(
    (a, b) => b.readers - a.readers || b.shadows - a.shadows || b.layers - a.layers,
  );
}
