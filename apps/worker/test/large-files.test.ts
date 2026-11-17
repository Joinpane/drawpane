/**
 * Files larger than any one message the server may send (decision 0026):
 * about 121,000 nodes of about 330 bytes, 40 MB of JSON, past Cloudflare's
 * 32 MiB cap on one RPC call and the old 24 MB import. Every path that used
 * to gather a whole file (import, versions, restore, branches, duplicates,
 * libraries, MCP reads) works through them a page at a time.
 *
 * Local workerd doesn't hold the room to 128 MB; the memory check is
 * `pnpm --filter @drawpane/worker memory` (test-node/), which runs the same
 * code in Node at 500,000 nodes.
 */
import { env } from "cloudflare:test";
import {
  type BranchInfo,
  IMPORT_PART_BYTES,
  keyBetween,
  type NodeRecord,
  type Op,
  parseBranchReview,
  parseSnapshot,
  ROOT_ID,
  type VersionInfo,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { snapshotKey } from "../src/rooms/snapshots";
import { type Browser, openSocket, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

const PAGES = 4;
const FRAMES = 300;
const LEAVES = 100;
const TOTAL = PAGES + PAGES * FRAMES + PAGES * FRAMES * LEAVES;
const SLOW = 600_000;

const KEYS: string[] = [];
for (let i = 0, key: string | null = null; i < FRAMES; i++) {
  key = keyBetween(key, null);
  KEYS.push(key);
}

/** A key after every sibling's. */
const LAST_KEY = keyBetween(KEYS.at(-1) as string, null);

/** A small seeded random source, so the same file can be made again. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The file's nodes, a frame at a time: pages, frames (every 25th a
 * component), and paths whose data is random digits, so it doesn't
 * compress to nothing (its snapshot is several R2 parts).
 */
function* bigFile(seed = 1): Generator<NodeRecord[]> {
  const next = random(seed);
  const digits = () => {
    let s = "M0 0";
    while (s.length < 200) s += ` L${Math.floor(next() * 1e6)} ${Math.floor(next() * 1e6)}`;
    return s;
  };
  for (let p = 0; p < PAGES; p++) {
    const page = `P${p}`;
    yield [
      {
        id: page,
        type: "page",
        parent: ROOT_ID,
        key: KEYS[p] as string,
        props: { name: `Page ${p}` },
      },
    ];
    for (let f = 0; f < FRAMES; f++) {
      const frame = `F${p}x${f}`;
      const batch: NodeRecord[] = [
        {
          id: frame,
          type: "frame",
          parent: page,
          key: KEYS[f] as string,
          props: {
            name: `Frame ${f}`,
            x: f * 10,
            y: 0,
            width: 400,
            height: 300,
            ...(f % 25 === 0 ? { isComponent: true } : {}),
          },
        },
      ];
      for (let l = 0; l < LEAVES; l++)
        batch.push({
          id: `N${p}x${f}x${l}`,
          type: "path",
          parent: frame,
          key: KEYS[l] as string,
          props: { name: `Path ${l}`, x: l, y: l, width: 10, height: 10, pathData: digits() },
        });
      yield batch;
    }
  }
}

/** The file's nodes in parts of about IMPORT_PART_BYTES of JSON. */
function* parts(seed = 1, change?: (node: NodeRecord) => NodeRecord): Generator<NodeRecord[]> {
  let part: NodeRecord[] = [];
  let bytes = 0;
  for (const batch of bigFile(seed))
    for (const raw of batch) {
      const node = change ? change(raw) : raw;
      part.push(node);
      bytes += JSON.stringify(node).length;
      if (bytes >= IMPORT_PART_BYTES) {
        yield part;
        part = [];
        bytes = 0;
      }
    }
  if (part.length > 0) yield part;
}

async function newFile(browser: Browser, projectId: string, name = "Kit") {
  const { file } = await browser.json<{ file: { id: string } }>(
    `/api/projects/${projectId}/files`,
    { method: "POST", json: { name } },
  );
  return file.id;
}

/** Imports the big file in parts, as the browser does; returns the bytes sent. */
async function importBig(browser: Browser, fileId: string, last?: NodeRecord[]) {
  const { importId } = await browser.json<{ importId: string }>(`/api/files/${fileId}/imports`, {
    method: "POST",
    json: {},
  });
  let sent = 0;
  for (const nodes of [...parts(), ...(last ? [last] : [])]) {
    const body = JSON.stringify({ nodes });
    sent += body.length;
    const response = await browser.fetch(`/api/files/${fileId}/imports/${importId}/parts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
  }
  const commit = await browser.fetch(`/api/files/${fileId}/imports/${importId}/commit`, {
    method: "POST",
    json: {},
  });
  return { sent, commit };
}

/** A socket that's caught up, for edits (it doesn't read the file). */
async function editor(browser: Browser, fileId: string, clientId: string) {
  const socket = await openSocket(browser, fileId);
  const { revn } = await roomOf(fileId).stats();
  socket.send({ t: "hello", protocol: 2, clientId, revn, copies: ["materialized", "compact"] });
  await socket.next("welcome", 10_000);
  let seq = 0;
  return async (ops: Op[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    return (await socket.next<{ revn: number }>("ack", 30_000)).revn;
  };
}

const node = async (fileId: string, nodeId: string) =>
  (await roomOf(fileId).readDocument(fileId, { kind: "node", nodeId })) as {
    props?: Record<string, unknown>;
    error?: string;
  };

describe("files larger than one message", () => {
  it(
    "imports in parts, all or nothing",
    async () => {
      const owner = await signedInUser("Ana");
      const fileId = await newFile(owner.browser, owner.projectId);

      // One node at the end whose parent isn't anywhere: the whole import is refused.
      const bad = await importBig(owner.browser, fileId, [
        { id: "Orphan", type: "rect", parent: "Missing", key: "a0", props: {} },
      ]);
      expect(bad.sent).toBeGreaterThan(32 * 1024 * 1024);
      expect(bad.commit.status).toBe(400);
      expect(JSON.stringify(await bad.commit.json())).toContain("Parent Missing doesn't exist");
      expect((await roomOf(fileId).stats()).nodes).toBe(1);

      const good = await importBig(owner.browser, fileId);
      expect(good.commit.status).toBe(200);
      expect(await good.commit.json()).toMatchObject({ nodes: TOTAL });
      expect((await roomOf(fileId).stats()).nodes).toBe(TOTAL);

      // Someone opening it downloads it (download.test.ts). A client that can't is never sent
      // more than the socket's bound (decision 0029): it views a page saying to reload.
      const reader = await openSocket(owner.browser, fileId);
      reader.send({
        t: "hello",
        protocol: 2,
        clientId: "reader",
        revn: null,
        copies: ["materialized", "compact"],
        download: true,
      });
      expect((await reader.next<{ mode: string }>("welcome", 10_000)).mode).toBe("download");
      reader.ws.close();
      const socket = await openSocket(owner.browser, fileId);
      socket.send({
        t: "hello",
        protocol: 2,
        clientId: "no-download",
        revn: null,
        copies: ["materialized", "compact"],
      });
      expect((await socket.next<{ role: string }>("welcome", 10_000)).role).toBe("viewer");
      const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot", 10_000);
      expect(chunk.done).toBe(true);
      expect(chunk.nodes.map((n) => n.id)).toEqual([
        "drawpane-reload-page",
        "drawpane-reload-text",
      ]);
    },
    SLOW,
  );

  it(
    "saves versions in parts and restores them, old and new",
    async () => {
      const owner = await signedInUser("Ana");
      const fileId = await newFile(owner.browser, owner.projectId);
      expect((await importBig(owner.browser, fileId)).commit.status).toBe(200);

      const { version } = await owner.browser.json<{ version: VersionInfo & { revn: number } }>(
        `/api/files/${fileId}/versions`,
        { method: "POST", json: { name: "Imported" } },
      );
      const stored = await env.FILES.head(snapshotKey(fileId, version.revn));
      // More than one 8 MiB part: written as a multipart upload.
      expect(stored?.size).toBeGreaterThan(8 * 1024 * 1024);

      // Read back whole (as the browser's history preview does).
      const preview = await owner.browser.fetch(
        `/api/files/${fileId}/versions/${version.id}/snapshot`,
      );
      const read = parseSnapshot(await preview.text());
      expect(read?.header.version).toBe(2);
      expect(read?.nodes.length).toBe(TOTAL);

      // Edit a lot: a page gone, a name changed, a layer added.
      const edit = await editor(owner.browser, fileId, "editor1");
      await edit([
        { op: "delete", id: "P1" },
        { op: "set", id: "N0x0x0", prop: "name", value: "Renamed" },
        { op: "create", id: "Extra", type: "rect", parent: "F0x0", key: LAST_KEY, props: {} },
      ]);
      expect((await roomOf(fileId).stats()).nodes).toBe(TOTAL - 1 - FRAMES - FRAMES * LEAVES + 1);

      const restore = async (versionId: string) =>
        owner.browser.json<{ changed: number; revn: number }>(
          `/api/files/${fileId}/versions/${versionId}/restore`,
          { method: "POST", json: { sessionId: null } },
        );
      const restored = await restore(version.id);
      // Every node of the page came back, the name and the extra layer went.
      expect(restored.changed).toBe(1 + FRAMES + FRAMES * LEAVES + 2);
      expect((await roomOf(fileId).stats()).nodes).toBe(TOTAL);
      expect((await node(fileId, "N0x0x0")).props?.name).toBe("Path 0");
      expect((await node(fileId, "Extra")).error).toBeDefined();
      expect((await node(fileId, "N1x5x5")).props?.name).toBe("Path 5");

      // A version 1 snapshot (one JSON object) of the same size still restores.
      const nodes: NodeRecord[] = [];
      for (const batch of bigFile()) nodes.push(...batch);
      const first = nodes.find((n) => n.id === "N2x7x7") as NodeRecord;
      nodes[nodes.indexOf(first)] = { ...first, props: { ...first.props, name: "From v1" } };
      const v1 = `{"format":"drawpane.snapshot","version":1,"fileId":"${fileId}","revn":${version.revn},"at":1,"nodes":[${nodes.map((n) => JSON.stringify(n)).join(",")}]}`;
      expect(v1.length).toBeGreaterThan(32 * 1024 * 1024);
      const gz = await new Response(
        new Blob([v1]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer();
      await env.FILES.put(snapshotKey(fileId, version.revn), gz);
      await edit([{ op: "set", id: "N2x7x7", prop: "name", value: "Edited" }]);
      const fromV1 = await restore(version.id);
      expect(fromV1.changed).toBe(1);
      expect((await node(fileId, "N2x7x7")).props?.name).toBe("From v1");
      expect((await roomOf(fileId).stats()).nodes).toBe(TOTAL);
    },
    SLOW,
  );

  it(
    "branches, reviews, merges and updates",
    async () => {
      const owner = await signedInUser("Ana");
      const mainId = await newFile(owner.browser, owner.projectId);
      expect((await importBig(owner.browser, mainId)).commit.status).toBe(200);

      const { branch } = await owner.browser.json<{ branch: BranchInfo }>(
        `/api/files/${mainId}/branches`,
        { method: "POST", json: { name: "Rework" } },
      );
      expect((await roomOf(branch.id).stats()).nodes).toBe(TOTAL);

      // The branch renames 500 paths, deletes a frame and adds one; main moves 500 others.
      const onBranch = await editor(owner.browser, branch.id, "b1");
      const renames: Op[] = [];
      for (let l = 0; l < LEAVES; l++)
        for (let f = 0; f < 5; f++)
          renames.push({ op: "set", id: `N0x${f}x${l}`, prop: "name", value: `Renamed ${f} ${l}` });
      await onBranch(renames);
      await onBranch([
        { op: "delete", id: "F3x9" },
        { op: "create", id: "NewFrame", type: "frame", parent: "P2", key: LAST_KEY, props: {} },
        { op: "create", id: "NewRect", type: "rect", parent: "NewFrame", key: "a0", props: {} },
      ]);
      const onMain = await editor(owner.browser, mainId, "m1");
      const moves: Op[] = [];
      for (let l = 0; l < LEAVES; l++)
        for (let f = 10; f < 15; f++)
          moves.push({ op: "set", id: `N1x${f}x${l}`, prop: "x", value: 999 });
      await onMain(moves);

      // Review streams all three files.
      const response = await owner.browser.fetch(`/api/files/${branch.id}/branch/review`);
      expect(response.status).toBe(200);
      const review = parseBranchReview(await response.text());
      expect(review.base.length).toBe(TOTAL);
      expect(review.branch.length).toBe(TOTAL - 1 - LEAVES + 2);
      expect(review.main.length).toBe(TOTAL);

      // Updating the branch takes main's 500 changes.
      const updated = await owner.browser.json<{ changes: number; kept: number }>(
        `/api/files/${branch.id}/branch/update`,
        { method: "POST", json: {} },
      );
      expect(updated).toMatchObject({ changes: 500, kept: 0 });
      expect((await node(branch.id, "N1x10x0")).props?.x).toBe(999);

      // Merging takes the branch's: 500 renames, a frame deleted, two layers added.
      const merged = await owner.browser.json<{ revn: number }>(
        `/api/files/${branch.id}/branch/merge`,
        { method: "POST", json: {} },
      );
      expect(merged.revn).toBeGreaterThan(0);
      const info = await owner.browser.json<{ branch: BranchInfo }>(`/api/files/${branch.id}`);
      expect(info.branch?.merged?.changes).toBe(500 + 1 + 2);
      expect((await roomOf(mainId).stats()).nodes).toBe(TOTAL - 1 - LEAVES + 2);
      expect((await node(mainId, "N0x4x99")).props?.name).toBe("Renamed 4 99");
      expect((await node(mainId, "N1x10x0")).props?.x).toBe(999);
      expect((await node(mainId, "F3x9")).error).toBeDefined();
      expect((await node(mainId, "NewRect")).props).toBeDefined();
    },
    SLOW,
  );

  it(
    "duplicates, publishes as a library, and answers MCP reads",
    async () => {
      const owner = await signedInUser("Ana");
      const fileId = await newFile(owner.browser, owner.projectId);
      expect((await importBig(owner.browser, fileId)).commit.status).toBe(200);

      const { file: copy } = await owner.browser.json<{ file: { id: string } }>(
        `/api/projects/${owner.projectId}/files`,
        { method: "POST", json: { name: "Copy", from: fileId } },
      );
      expect((await roomOf(copy.id).stats()).nodes).toBe(TOTAL);

      const { publish } = await owner.browser.json<{
        publish: { assets: Array<{ id: string }>; revn: number };
      }>(`/api/files/${fileId}/library/publish`, { method: "POST", json: {} });
      // Every 25th frame is a component, in file order.
      expect(publish.assets.length).toBe(PAGES * (FRAMES / 25));
      expect(publish.assets[0]?.id).toBe("F0x0");
      expect(publish.assets[1]?.id).toBe("F0x25");
      expect(await env.FILES.head(snapshotKey(fileId, publish.revn))).not.toBeNull();

      const found = (await roomOf(fileId).readDocument(fileId, {
        kind: "find",
        query: "Path 42",
        limit: 5,
      })) as { nodes: unknown[]; total: number };
      expect(found.total).toBe(PAGES * FRAMES);
      expect(found.nodes.length).toBe(5);
      const outline = (await roomOf(fileId).readDocument(fileId, {
        kind: "outline",
        depth: 2,
        limit: 50,
      })) as { pages: unknown[]; outline: { truncated: boolean } };
      expect(outline.pages.length).toBe(PAGES);
      expect(outline.outline.truncated).toBe(true);
    },
    SLOW,
  );
});
