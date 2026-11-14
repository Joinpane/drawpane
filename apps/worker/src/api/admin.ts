/**
 * The instance admin's view of how the instance is doing: who's editing,
 * how fast edits are confirmed, what's stored, what it costs, whether each
 * service answers, and when the last backup was taken. See
 * docs/decisions/0003-instance-health.md for what's measured and why it's
 * cheap. Admins only.
 */
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { badRequest, forbidden } from "../lib/http";
import { type AvailableUpdate, availableUpdate } from "./updates";

const PERIODS = [7, 30, 90] as const;
/** A room that reported this recently is being edited now. */
const BUSY_MS = 2 * 60_000;
/** Version snapshots are kept this long (named ones for good). */
const RETENTION_DAYS = 30;
const GB = 1024 ** 3;

/**
 * Cloudflare's Workers Paid prices (November 2026): the base plan, and storage
 * beyond what it includes. Request and compute charges aren't counted, so the
 * total is an estimate (see the decision record).
 */
const PRICES = {
  basePlan: 5,
  r2IncludedGb: 10,
  r2PerGbMonth: 0.015,
  durableIncludedGb: 5,
  durablePerGbMonth: 0.2,
} as const;

export interface ServiceHealth {
  readonly name: string;
  readonly status: "healthy" | "slow" | "down";
  readonly metric: string;
}

export interface InstanceHealth {
  readonly days: number;
  readonly activeEditors: number;
  readonly edits: number;
  /** Send-to-confirm time for an edit, as clients report it; null until there's enough. */
  readonly latencyP95Ms: number | null;
  readonly storage: { readonly r2Bytes: number; readonly roomBytes: number };
  readonly cost: {
    readonly estimateUsd: number;
    readonly items: readonly { readonly name: string; readonly usd: number }[];
  };
  readonly files: { readonly total: number; readonly busy: number };
  readonly services: readonly ServiceHealth[];
  readonly lastBackupAt: number | null;
  readonly retentionDays: number;
  /** The Drawpane release running, or null when it wasn't installed by the installer. */
  readonly version: string | null;
  /** A newer release, when there is one. */
  readonly update: AvailableUpdate | null;
}

/** A latency histogram's p95 from its log₂ buckets ("latency_le_64" → at most 64 ms). */
export function p95(buckets: ReadonlyMap<number, number>, minSamples = 20): number | null {
  const sorted = [...buckets].sort(([a], [b]) => a - b);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  if (total < minSamples) return null;
  let seen = 0;
  for (const [ceiling, n] of sorted) {
    seen += n;
    if (seen >= total * 0.95) return Number.isFinite(ceiling) ? ceiling : null;
  }
  return null;
}

/** Times one service check; slow past `slowMs`, down when it throws. */
async function check(
  name: string,
  slowMs: number,
  probe: () => Promise<string>,
): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const detail = await probe();
    const ms = Date.now() - start;
    return {
      name,
      status: ms > slowMs ? "slow" : "healthy",
      metric: detail ? `${ms} ms · ${detail}` : `${ms} ms`,
    };
  } catch {
    return { name, status: "down", metric: "Not answering" };
  }
}

export async function instanceHealth(
  env: Env,
  days: number,
  now = Date.now(),
): Promise<InstanceHealth> {
  const since = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const db = env.DB;
  const [editors, edits, latency, media, versions, rooms, files, backup] = await db.batch([
    db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM editors_daily WHERE day >= ?").bind(since),
    db
      .prepare(
        "SELECT COALESCE(SUM(value), 0) AS n FROM usage_daily WHERE day >= ? AND metric = 'edits'",
      )
      .bind(since),
    db
      .prepare(
        "SELECT metric, SUM(value) AS n FROM usage_daily WHERE day >= ? AND metric LIKE 'latency_le_%' GROUP BY metric",
      )
      .bind(since),
    db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM media"),
    db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM versions"),
    db
      .prepare(
        "SELECT COALESCE(SUM(bytes), 0) AS n, COUNT(CASE WHEN updated_at > ? THEN 1 END) AS busy FROM room_storage",
      )
      .bind(now - BUSY_MS),
    db.prepare("SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL"),
    db.prepare("SELECT MAX(created_at) AS at FROM versions"),
  ]);
  const first = <T>(r: D1Result<unknown> | undefined) => (r?.results[0] ?? {}) as T;
  const buckets = new Map<number, number>();
  for (const row of (latency?.results ?? []) as { metric: string; n: number }[]) {
    const ceiling =
      row.metric === "latency_le_inf" ? Number.POSITIVE_INFINITY : Number(row.metric.slice(11));
    if (!Number.isNaN(ceiling)) buckets.set(ceiling, row.n);
  }
  const r2Bytes = first<{ n: number }>(media).n + first<{ n: number }>(versions).n;
  const roomBytes = first<{ n: number }>(rooms).n;
  const r2Over = Math.max(0, r2Bytes / GB - PRICES.r2IncludedGb) * PRICES.r2PerGbMonth;
  const durableOver =
    Math.max(0, roomBytes / GB - PRICES.durableIncludedGb) * PRICES.durablePerGbMonth;
  const items = [
    { name: "Workers Paid plan", usd: PRICES.basePlan },
    { name: "R2 storage beyond 10 GB", usd: round2(r2Over) },
    { name: "Durable Object storage beyond 5 GB", usd: round2(durableOver) },
  ];

  const version = env.DRAWPANE_VERSION?.trim() || null;
  const [update, services] = await Promise.all([
    availableUpdate(env, version),
    Promise.all([
      check("D1", 50, async () => {
        await db.prepare("SELECT 1").first();
        return "";
      }),
      check("R2", 200, async () => {
        await env.FILES.head("health-check");
        return formatBytes(r2Bytes);
      }),
    ]),
  ]);
  const total = first<{ n: number }>(files).n;
  const busy = first<{ busy: number }>(rooms).busy ?? 0;
  services.push({
    name: "FileRoom objects",
    status: "healthy",
    metric: `${busy} being edited · ${Math.max(0, total - busy)} asleep`,
  });

  return {
    days,
    activeEditors: first<{ n: number }>(editors).n,
    edits: first<{ n: number }>(edits).n,
    latencyP95Ms: p95(buckets),
    storage: { r2Bytes, roomBytes },
    cost: { estimateUsd: round2(items.reduce((s, i) => s + i.usd, 0)), items },
    files: { total, busy },
    services,
    lastBackupAt: first<{ at: number | null }>(backup).at ?? null,
    retentionDays: RETENTION_DAYS,
    version,
    update,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < GB) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

export const admin = new Hono<AppContext>().get("/health", async (c) => {
  const user = requireUser(c);
  if (!user.isAdmin) throw forbidden("Only the instance's admin can see its health.");
  const days = Number(c.req.query("days") ?? 30);
  if (!PERIODS.includes(days as (typeof PERIODS)[number]))
    throw badRequest("The period is 7, 30 or 90 days.");
  return c.json(await instanceHealth(c.env, days));
});
