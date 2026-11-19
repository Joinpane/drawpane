/**
 * CPU profiles of benchmark measurements: run under Chrome's profiler, saved
 * as `.cpuprofile` (Chrome's performance panel opens them) and summarised
 * by self time and time with callees. Built bundles mangle names: resolve
 * them through apps/web/dist/assets/*.map.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession } from "@playwright/test";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

/** Runs `work` under the CPU profiler when BENCH_PROFILE is set; saves the profile and prints where the time went. */
export async function profiled<T>(
  cdp: CDPSession,
  dir: string | undefined,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!dir) return work();
  await cdp.send("Profiler.start");
  const result = await work();
  const { profile } = await cdp.send("Profiler.stop");
  console.log(summarizeProfile(dir, name, profile));
  return result;
}

/** Saves a profile in `dir` as `<name>.cpuprofile` and says where its time went. */
export function summarizeProfile(dir: string, name: string, data: unknown): string {
  const profile = data as { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name.replace(/[^\w.-]+/g, "_")}.cpuprofile`), JSON.stringify(profile));
  // Self time by function, and time with callees (each function counted once per sample).
  const parent = new Map<number, number>();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n: ProfileNode) =>
    `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`;
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let all = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    all += dt;
    const leaf = byId.get(id);
    if (!leaf) return;
    self.set(label(leaf), (self.get(label(leaf)) ?? 0) + dt);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const n = byId.get(at);
      if (!n) break;
      const l = label(n);
      if (seen.has(l)) continue;
      seen.add(l);
      total.set(l, (total.get(l) ?? 0) + dt);
    }
  });
  const top = (m: Map<string, number>, k: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([l, ms]) => `    ${String(Math.round(ms)).padStart(7)} ms  ${l}`)
      .join("\n");
  return `Profile ${name}: ${Math.round(all)} ms\n  self:\n${top(self, 20)}\n  with callees:\n${top(total, 40)}`;
}
