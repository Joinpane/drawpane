import { env, runDurableObjectAlarm } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type InstanceHealth, p95 } from "../src/api/admin";
import { openSocket, signedInUser } from "./helpers";

const makeAdmin = (userId: string) =>
  env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(userId).run();

async function edit(browser: Parameters<typeof openSocket>[0], fileId: string, count: number) {
  const socket = await openSocket(browser, fileId);
  socket.send({ t: "hello", protocol: 1, clientId: `c-${fileId}`, revn: null });
  await socket.next("welcome");
  let page: NodeRecord | undefined;
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    page ??= chunk.nodes[0];
    if (chunk.done) break;
  }
  for (let i = 1; i <= count; i++) {
    const op: Op = {
      op: "create",
      id: `r${i}`,
      type: "rect",
      parent: (page as NodeRecord).id,
      key: `a${i}`,
      props: { width: 10, height: 10 },
    };
    socket.send({ t: "txn", seq: i, ops: [op] });
    await socket.next("ack");
  }
}

describe("instance health", () => {
  it("is for the instance's admin only", async () => {
    const someone = await signedInUser("Bo");
    const denied = await someone.browser.fetch("/api/admin/health");
    expect(denied.status).toBe(403);
    await makeAdmin(someone.userId);
    const health = await someone.browser.json<InstanceHealth>("/api/admin/health?days=7");
    expect(health.days).toBe(7);
    expect(health.services.map((s) => s.name)).toEqual(["D1", "R2", "FileRoom objects"]);
    expect(health.services.slice(0, 2).every((s) => s.status !== "down")).toBe(true);
    expect(health.cost.items[0]).toEqual({ name: "Workers Paid plan", usd: 5 });
    expect(health.retentionDays).toBe(30);
    // Only the periods the page offers.
    expect((await someone.browser.fetch("/api/admin/health?days=12")).status).toBe(400);
  });

  it("counts edits and editors in each room, and reports them when its alarm runs", async () => {
    const ana = await signedInUser("Ana");
    await makeAdmin(ana.userId);
    const { file } = await ana.browser.json<{ file: { id: string } }>(
      `/api/projects/${ana.projectId}/files`,
      { method: "POST", json: { name: "Counted" } },
    );
    const before = await ana.browser.json<InstanceHealth>("/api/admin/health?days=7");
    await edit(ana.browser, file.id, 3);
    // Nothing reaches D1 per edit: the room's alarm reports it in one batch.
    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(file.id));
    await runDurableObjectAlarm(stub);
    const after = await ana.browser.json<InstanceHealth>("/api/admin/health?days=7");
    expect(after.edits - before.edits).toBe(3);
    expect(after.activeEditors).toBeGreaterThanOrEqual(1);
    expect(after.storage.roomBytes).toBeGreaterThan(before.storage.roomBytes);
    expect(after.files.busy).toBeGreaterThanOrEqual(1);
    // Clients report how long confirmations took: 40 fast, 2 slow.
    const reporter = await openSocket(ana.browser, file.id);
    reporter.send({ t: "hello", protocol: 1, clientId: "reporter", revn: null });
    await reporter.next("welcome");
    reporter.send({ t: "stats", latency: [0, 0, 0, 40, 0, 0, 0, 0, 2, 0, 0] });
    reporter.send({ t: "ping" });
    await reporter.next("pong");
    await runDurableObjectAlarm(stub);
    const timed = await ana.browser.json<InstanceHealth>("/api/admin/health?days=7");
    // The 95th of 42: within the 64 ms bucket.
    expect(timed.latencyP95Ms).toBe(64);
    // A second alarm has nothing new to add.
    await runDurableObjectAlarm(stub);
    const again = await ana.browser.json<InstanceHealth>("/api/admin/health?days=7");
    expect(again.edits).toBe(after.edits);
    expect(again.latencyP95Ms).toBe(64);
  });
});

describe("p95", () => {
  it("reads the 95th percentile from log₂ buckets, once there's enough data", () => {
    expect(p95(new Map([[64, 5]]))).toBeNull();
    const buckets = new Map([
      [32, 50],
      [64, 40],
      [128, 6],
      [256, 4],
    ]);
    expect(p95(buckets)).toBe(128);
    expect(p95(new Map([[Number.POSITIVE_INFINITY, 100]]))).toBeNull();
  });
});
