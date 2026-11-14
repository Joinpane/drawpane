# 0003. Instance health and cost: what we measure, and how cheaply

- Status: proposed
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

PRD v0.1 promises self-hosters a health page ("Self-host: … R2 backups, health page"), and the `Health` design shows one: cost this month, active editors, edit latency p95, storage, a cost breakdown, service status, the last R2 snapshot, and an upgrade notice, inside an "Instance admin" area.

None of those numbers exist today. The Worker keeps no usage counters, there is no notion of an instance admin, and Cloudflare's own figures (billing, analytics) need an API token most self-hosters won't configure. Whatever we add must also respect the PRD's promise that an instance costs about $5–20 a month: measuring must not become a noticeable share of the bill.

## Decision

**An instance admin.** `users.is_admin`, set for the account that ran setup (and backfilled for the oldest account). Only admins see the admin area. Promoting others comes with the Members page.

**Counters kept by each room, flushed rarely.** Each FileRoom counts usage in its own SQLite, inside the same storage transaction as the edit (rooms hibernate, so memory alone would lose counts). The alarm that already runs about 30 seconds after edits moves the counts to D1 in one batch. If D1 fails, the counts go back and wait for the next alarm. That's one small batch per active file per alarm, not one per edit:

- `usage_daily(day, metric, value)`: edits, edit sessions, and a latency histogram in fixed log₂ buckets (`latency_ms_le_8`, `_16`, … `_4096`, `_inf`). A p95 comes from the buckets without storing samples.
- `editors_daily(day, user_id)`: who edited on which day. "Active editors" over 7, 30 or 90 days is a distinct count.
- `room_storage(file_id, bytes, updated_at)`: each room reports its SQLite size (`ctx.storage.sql.databaseSize`) when it flushes.

**Latency is what people feel, reported by the client.** The client already knows when the room confirms its edit (`ack`). It measures send-to-ack and sends a histogram with its presence updates, which the room adds to its counters. The page labels it "Edit confirmed, p95". Server processing alone would flatter us.

**Storage from what we already record.** R2 holds media (`media` rows carry sizes) and version snapshots (`versions.size` already holds each one's compressed size). No bucket listing is needed.

**Cost is an estimate, said plainly.** It's the Workers Paid base plan plus what we can measure exactly: storage beyond the included allowances (R2 and Durable Object storage). Request and compute charges aren't counted, so the page says "Estimate" and links to the Cloudflare dashboard. For a typical instance, usage stays inside the allowances. If an analytics-read API token is configured later, exact figures replace the estimate.

**Services are checked live.** When the page loads: D1 answers `SELECT 1` (timed), R2 answers a `head` (timed), and FileRooms are counted as awake if they flushed in the last two minutes, asleep otherwise. Queue and Email rows appear only when those bindings exist.

**Last backup.** The newest version snapshot across files, with the 30-day retention the PRD promises.

**Upgrades.** The running version is a build-time constant. A "new version available" check waits until releases are published.

## Consequences

- One D1 migration (`is_admin`, `usage_daily`, `editors_daily`, `room_storage`).
- A busy instance adds about one D1 write batch per active file per minute: negligible next to the edits themselves.
- Latency depends on clients reporting it. Old clients report nothing, and the page says "Not enough data yet" until there's some.
- Numbers start from the deploy that adds this. There's no backfill of past usage.
