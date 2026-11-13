import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { NodeRecord, Op, VersionInfo } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { snapshotKey } from "../src/rooms/snapshots";
import { type Browser, openSocket, signedInUser } from "./helpers";

async function newFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "History" } },
  );
  return { ...owner, fileId: file.id };
}

async function join(browser: Browser, fileId: string, clientId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({ t: "hello", protocol: 1, clientId, revn: null });
  const welcome = await socket.next<{ sessionId: string; revn: number }>("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  let seq = 0;
  /** Sends a transaction and waits for the room to accept it. */
  const edit = async (ops: Op[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    return (await socket.next<{ revn: number }>("ack")).revn;
  };
  const page = nodes.find((n) => n.type === "page") as NodeRecord;
  return { ...socket, welcome, nodes, page, edit };
}

const rect = (id: string, parent: string, props = {}): Op => ({
  op: "create",
  id,
  type: "rect",
  parent,
  key: "a0",
  props: { x: 0, y: 0, width: 100, height: 50, ...props },
});

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

async function list(browser: Browser, fileId: string) {
  return (await browser.json<{ versions: VersionInfo[] }>(`/api/files/${fileId}/versions`))
    .versions;
}

async function name(browser: Browser, fileId: string, versionName: string, description?: string) {
  return (
    await browser.json<{ version: VersionInfo }>(`/api/files/${fileId}/versions`, {
      method: "POST",
      json: { name: versionName, description },
    })
  ).version;
}

describe("versions", () => {
  it("saves the current state under a name, with who edited and what changed", async () => {
    const { browser, fileId, userId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    await a.edit([rect("card", a.page.id)]);
    await a.edit([{ op: "set", id: "card", prop: "fills", value: [] }]);
    const revn = await a.edit([{ op: "set", id: "card", prop: "x", value: 40 }]);

    expect(await list(browser, fileId)).toEqual([]);
    const version = await name(browser, fileId, "  Before color pass ", "First cut");
    expect(version).toMatchObject({
      revn,
      reason: "named",
      name: "Before color pass",
      description: "First cut",
      createdBy: { id: userId, name: "Ana" },
      authors: [{ id: userId, name: "Ana" }],
      summary: { edits: 3, kinds: { added: 1, style: 1, geometry: 1 } },
    });
    expect(version.size).toBeGreaterThan(0);

    // Naming again with nothing new renames the same version.
    const again = await name(browser, fileId, "Kickoff");
    expect(again.id).toBe(version.id);
    expect(await list(browser, fileId)).toMatchObject([{ id: version.id, name: "Kickoff" }]);

    // The snapshot holds the file at that revision.
    const response = await browser.fetch(`/api/files/${fileId}/versions/${version.id}/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    const snapshot = (await response.json()) as { revn: number; nodes: NodeRecord[] };
    expect(snapshot.revn).toBe(revn);
    expect(snapshot.nodes.find((n) => n.id === "card")?.props).toMatchObject({ x: 40, fills: [] });
  });

  it("renames, describes and un-names versions", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    await a.edit([rect("card", a.page.id)]);
    const version = await name(browser, fileId, "Draft");
    const patch = (json: unknown) =>
      browser.json<{ version: VersionInfo }>(`/api/files/${fileId}/versions/${version.id}`, {
        method: "PATCH",
        json,
      });
    expect((await patch({ description: "Notes" })).version).toMatchObject({
      name: "Draft",
      description: "Notes",
    });
    expect((await patch({ name: "Final" })).version).toMatchObject({
      name: "Final",
      description: "Notes",
    });
    expect((await patch({ name: null })).version).toMatchObject({ name: null, description: null });
    const bad = await browser.fetch(`/api/files/${fileId}/versions/${version.id}`, {
      method: "PATCH",
      json: { name: "   " },
    });
    expect(bad.status).toBe(400);
  });

  it("lets viewers look at versions but not save or restore them", async () => {
    const { browser, fileId, teamId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    await a.edit([rect("card", a.page.id)]);
    const version = await name(browser, fileId, "V1");

    const viewer = await signedInUser("Vi", "viewer", teamId);
    expect(await list(viewer.browser, fileId)).toHaveLength(1);
    expect(
      (await viewer.browser.fetch(`/api/files/${fileId}/versions/${version.id}/snapshot`)).status,
    ).toBe(200);
    for (const [path, method] of [
      [`/api/files/${fileId}/versions`, "POST"],
      [`/api/files/${fileId}/versions/${version.id}`, "PATCH"],
      [`/api/files/${fileId}/versions/${version.id}/restore`, "POST"],
    ] as const) {
      expect((await viewer.browser.fetch(path, { method, json: { name: "x" } })).status).toBe(403);
    }

    // Outsiders see nothing at all.
    const stranger = await signedInUser("Sam");
    expect((await stranger.browser.fetch(`/api/files/${fileId}/versions`)).status).toBe(404);
    expect(
      (await stranger.browser.fetch(`/api/files/${fileId}/versions/${version.id}/snapshot`)).status,
    ).toBe(404);
    // A version id from another file doesn't resolve through this one.
    const other = await newFile();
    expect(
      (await other.browser.fetch(`/api/files/${other.fileId}/versions/${version.id}/snapshot`))
        .status,
    ).toBe(404);
  });

  it("restores the whole file for everyone, after saving a restore point", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    const b = await join(browser, fileId, "clientB");
    await a.edit([rect("card", a.page.id, { name: "Card" }), rect("old", a.page.id)]);
    const v1 = await name(browser, fileId, "V1");

    await a.edit([
      { op: "delete", id: "old" },
      { op: "set", id: "card", prop: "name", value: "Renamed" },
      rect("new", a.page.id),
    ]);
    const before = await a.edit([{ op: "set", id: "card", prop: "x", value: 99 }]);

    const response = await browser.json<{ revn: number; restorePoint: string; changed: number }>(
      `/api/files/${fileId}/versions/${v1.id}/restore`,
      { method: "POST", json: { sessionId: a.welcome.sessionId } },
    );
    expect(response.revn).toBe(before + 1);
    expect(response.changed).toBeGreaterThan(0);

    // Everyone gets the change, then (except the restorer) who did it.
    let change = await b.next<{ revn: number; ops: Op[] }>("txn");
    while (change.revn < response.revn) change = await b.next<{ revn: number; ops: Op[] }>("txn");
    expect(change.revn).toBe(response.revn);
    const restored = await b.next<{ by: { name: string }; version: { id: string } }>("restored");
    expect(restored).toMatchObject({ by: { name: "Ana" }, version: { id: v1.id, name: "V1" } });
    // Give the restorer's socket a moment: it gets the change but no notice.
    await a.next("txn");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.inbox.some((m) => m.t === "restored")).toBe(false);

    // A fresh client sees the file as it was in V1.
    const c = await join(browser, fileId, "clientC");
    const byId = new Map(c.nodes.map((n) => [n.id, n]));
    expect(byId.has("old")).toBe(true);
    expect(byId.has("new")).toBe(false);
    expect(byId.get("card")?.props).toMatchObject({ name: "Card", x: 0 });

    // The restore point holds the state just before, and says what it was for.
    const versions = await list(browser, fileId);
    const point = versions.find((v) => v.id === response.restorePoint);
    expect(point).toMatchObject({ reason: "restore", restoredId: v1.id, revn: before, name: null });

    // Restoring the restore point undoes the restore.
    await browser.json(`/api/files/${fileId}/versions/${response.restorePoint}/restore`, {
      method: "POST",
      json: {},
    });
    const d = await join(browser, fileId, "clientD");
    expect(d.nodes.some((n) => n.id === "new")).toBe(true);
    expect(d.nodes.find((n) => n.id === "card")?.props).toMatchObject({ x: 99 });

    // Restoring the version the file already matches changes nothing.
    const same = await browser.json<{ changed: number }>(
      `/api/files/${fileId}/versions/${response.restorePoint}/restore`,
      { method: "POST", json: {} },
    );
    expect(same.changed).toBe(0);
  });

  it("refuses to restore a version whose snapshot is gone", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    await a.edit([rect("card", a.page.id)]);
    const v1 = await name(browser, fileId, "V1");
    await env.FILES.delete(snapshotKey(fileId, v1.revn));
    const response = await browser.fetch(`/api/files/${fileId}/versions/${v1.id}/restore`, {
      method: "POST",
      json: {},
    });
    expect(response.status).toBe(409);
  });

  it("autosaves once editing pauses, and sweeps expired autosaves", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    await a.edit([rect("card", a.page.id)]);
    const stub = roomOf(fileId);

    // Not yet: someone edited just now.
    await runDurableObjectAlarm(stub);
    expect(await list(browser, fileId)).toEqual([]);

    // Eleven minutes later, the pause makes an autosave.
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("UPDATE log SET at = at - 11 * 60000");
    });
    await runDurableObjectAlarm(stub);
    const [auto] = await list(browser, fileId);
    expect(auto).toMatchObject({ reason: "auto", name: null, summary: { edits: 1 } });
    expect(await env.FILES.head(snapshotKey(fileId, auto?.revn ?? 0))).not.toBeNull();

    // More edits, a named version, then everything ages past 30 days.
    await a.edit([{ op: "set", id: "card", prop: "x", value: 1 }]);
    const named = await name(browser, fileId, "Keep me");
    await a.edit([{ op: "set", id: "card", prop: "x", value: 2 }]);
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("UPDATE log SET at = at - 11 * 60000");
      state.storage.sql.exec("DELETE FROM meta WHERE k = 'swept_at'");
    });
    await env.DB.prepare(
      "UPDATE versions SET created_at = created_at - 31 * 86400000 WHERE file_id = ?",
    )
      .bind(fileId)
      .run();
    await runDurableObjectAlarm(stub);

    const left = await list(browser, fileId);
    // The old autosave is gone; the named one stays, and so does the newest autosave.
    expect(left.map((v) => v.id)).not.toContain(auto?.id);
    expect(left.map((v) => v.id)).toContain(named.id);
    expect(left).toHaveLength(2);
    expect(await env.FILES.head(snapshotKey(fileId, auto?.revn ?? 0))).toBeNull();
  });

  it("lists snapshots saved before version history existed", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    const revn = await a.edit([rect("card", a.page.id)]);
    await env.FILES.put(snapshotKey(fileId, revn), new Uint8Array([1, 2, 3]));
    await runInDurableObject(roomOf(fileId), (_room, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE k IN ('swept_at', 'versions_indexed')");
    });
    await runDurableObjectAlarm(roomOf(fileId));
    expect(await list(browser, fileId)).toMatchObject([{ revn, reason: "auto", size: 3 }]);
  });
});
