import { env, runInDurableObject } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import type { FileRoom } from "../src/rooms/file-room";
import { STALE_MS } from "../src/rooms/file-room";
import { openSocket, signedInUser } from "./helpers";

async function newFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    {
      method: "POST",
      json: { name: "Room test" },
    },
  );
  return { ...owner, fileId: file.id };
}

async function join(
  browser: Parameters<typeof openSocket>[0],
  fileId: string,
  clientId: string,
  revn: number | null = null,
) {
  const socket = await openSocket(browser, fileId);
  socket.send({ t: "hello", protocol: 3, clientId, revn, copies: ["materialized", "compact"] });
  const welcome = await socket.next<{
    revn: number;
    mode: string;
    role: string;
    lastSeq: number;
    peers: unknown[];
  }>("welcome");
  const nodes: NodeRecord[] = [];
  if (welcome.mode === "snapshot") {
    for (;;) {
      const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
      nodes.push(...chunk.nodes);
      if (chunk.done) break;
    }
  }
  return { ...socket, welcome, nodes };
}

const rect = (id: string, parent: string, key = "a0"): Op => ({
  op: "create",
  id,
  type: "rect",
  parent,
  key,
  props: { x: 10, y: 20, width: 100, height: 50, fills: [{ type: "solid", color: "#ff5a1f" }] },
});

describe("FileRoom", () => {
  it("seeds a page, applies edits, acks the sender and broadcasts to peers", async () => {
    const { browser, fileId, teamId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    expect(a.welcome).toMatchObject({ mode: "snapshot", role: "owner", lastSeq: 0 });
    expect(a.nodes).toHaveLength(1);
    const page = a.nodes[0] as NodeRecord;
    expect(page).toMatchObject({ type: "page", props: { name: "Page 1" } });

    const teammate = await signedInUser("Bo", "editor", teamId);
    const b = await join(teammate.browser, fileId, "clientB");
    expect(b.welcome.peers).toHaveLength(1);
    await a.next("peer");

    a.send({ t: "txn", seq: 1, ops: [rect("r1", page.id)] });
    const ack = await a.next<{ seq: number; revn: number }>("ack");
    expect(ack).toMatchObject({ seq: 1, revn: a.welcome.revn + 1 });
    const remote = await b.next<{ revn: number; ops: Op[]; author: { userId: string } }>("txn");
    expect(remote.revn).toBe(ack.revn);
    expect(remote.ops).toEqual([rect("r1", page.id)]);

    // Presence goes to peers only.
    b.send({
      t: "presence",
      presence: { cursor: { x: 1, y: 2 }, pageId: page.id, selection: ["r1"] },
    });
    const presence = await a.next<{ presence: { selection: string[] } }>("presence");
    expect(presence.presence.selection).toEqual(["r1"]);
  });

  it("lets go of a session that has gone quiet, so its selection doesn't linger", async () => {
    const { browser, fileId, teamId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    const page = a.nodes[0] as NodeRecord;
    const teammate = await signedInUser("Bo", "editor", teamId);
    const b = await join(teammate.browser, fileId, "clientB");
    const bo = await a.next<{ peer: { sessionId: string } }>("peer");
    b.send({ t: "presence", presence: { cursor: null, pageId: page.id, selection: ["r1"] } });
    await a.next("presence");

    // Pings are answered for the room, without waking it.
    a.send({ t: "ping" });
    await a.next("pong");

    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
    // A moment later nobody is quiet yet.
    expect(await runInDurableObject(stub, (room: FileRoom) => room.pruneQuiet())).toBe(0);
    // Long after, both have been silent: with Ana's socket the one asking (it's talking), only
    // Bo's goes, and Ana hears that Bo left (his selection with him).
    const later = Date.now() + STALE_MS + 1000;
    const closed = await runInDurableObject(stub, (room: FileRoom, state) => {
      const ana = state
        .getWebSockets()
        .find((ws) => (ws.deserializeAttachment() as { name?: string } | null)?.name === "Ana");
      return room.pruneQuiet(later, ana);
    });
    expect(closed).toBe(1);
    const left = await a.next<{ sessionId: string }>("peer-left");
    expect(left.sessionId).toBe(bo.peer.sessionId);
    // Ana carries on as before.
    a.send({ t: "ping" });
    await a.next("pong");
  });

  it("rejects invalid transactions atomically and returns the current state", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    const page = a.nodes[0] as NodeRecord;
    a.send({ t: "txn", seq: 1, ops: [rect("r1", page.id)] });
    await a.next("ack");

    a.send({
      t: "txn",
      seq: 2,
      ops: [
        { op: "set", id: "r1", prop: "x", value: 500 },
        { op: "set", id: "r1", prop: "gap", value: 8 },
      ],
    });
    const reject = await a.next<{
      seq: number;
      code: string;
      fix: Record<string, NodeRecord | null>;
    }>("reject");
    expect(reject).toMatchObject({ seq: 2, code: "invalid_prop" });
    expect(reject.fix.r1?.props.x).toBe(10);

    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
    expect(await stub.stats()).toMatchObject({ nodes: 2 });
  });

  it("acks resent transactions without applying them twice, and catches up on reconnect", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    const page = a.nodes[0] as NodeRecord;
    a.send({ t: "txn", seq: 1, ops: [rect("r1", page.id)] });
    const first = await a.next<{ revn: number }>("ack");
    a.ws.close();

    const again = await join(browser, fileId, "clientA", first.revn - 1);
    expect(again.welcome).toMatchObject({ mode: "catchup", lastSeq: 1, revn: first.revn });
    const missed = await again.next<{ revn: number; ops: Op[] }>("txn");
    expect(missed.revn).toBe(first.revn);

    again.send({ t: "txn", seq: 1, ops: [rect("r1", page.id)] });
    expect(await again.next<{ seq: number; revn: number }>("ack")).toEqual({
      t: "ack",
      seq: 1,
      revn: first.revn,
    });
  });

  it("refuses edits from viewers and sockets from outsiders", async () => {
    const { browser, fileId, teamId } = await newFile();
    const owner = await join(browser, fileId, "clientA");
    const page = owner.nodes[0] as NodeRecord;

    const viewer = await signedInUser("Vi", "viewer", teamId);
    const v = await join(viewer.browser, fileId, "clientV");
    v.send({ t: "txn", seq: 1, ops: [rect("r1", page.id)] });
    expect(await v.next("reject")).toMatchObject({ code: "forbidden" });

    const outsider = await signedInUser("Out");
    const response = await outsider.browser.fetch(`/ws/files/${fileId}`, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(404);
  });

  it("hears a role change at once, and closes when its person is removed from the team", async () => {
    const { browser, fileId, teamId } = await newFile();
    const owner = await join(browser, fileId, "clientA");
    const page = owner.nodes[0] as NodeRecord;
    const lena = await signedInUser("Lena", "editor", teamId);
    const l = await join(lena.browser, fileId, "clientL");
    const connected = () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM room_connections WHERE file_id = ? AND user_id = ?")
        .bind(fileId, lena.userId)
        .first<{ n: number }>()
        .then((row) => row?.n ?? 0);
    await expect.poll(connected).toBe(1);

    // Made a viewer: told so, with who did it, and the next edit is refused.
    await browser.json(`/api/teams/${teamId}/members/${lena.userId}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });
    expect(await l.next("role")).toMatchObject({
      role: "viewer",
      previous: "editor",
      by: { name: "Ana" },
    });
    l.send({ t: "txn", seq: 1, ops: [rect("r1", page.id)] });
    expect(await l.next("reject")).toMatchObject({ code: "forbidden" });

    // Removed: the socket closes with 4401, and the room forgets her.
    const closed = new Promise<number>((resolve) =>
      l.ws.addEventListener("close", (event) => resolve(event.code)),
    );
    await browser.json(`/api/teams/${teamId}/members/${lena.userId}`, { method: "DELETE" });
    expect(await closed).toBe(4401);
    await expect.poll(connected).toBe(0);
    // The owner's own socket is untouched.
    owner.send({ t: "ping" });
    await owner.next("pong");
  });

  it("closes a socket whose person was removed between joining and saying hello", async () => {
    const { fileId, teamId } = await newFile();
    const lena = await signedInUser("Lena", "editor", teamId);
    // The Worker lets her in; then, before her hello, she's taken off the team without a notice.
    const socket = await openSocket(lena.browser, fileId);
    await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .bind(teamId, lena.userId)
      .run();
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.ws.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      ),
    );
    socket.send({
      t: "hello",
      protocol: 3,
      clientId: "clientL",
      revn: null,
      copies: ["materialized", "compact"],
    });
    expect(await closed).toEqual({ code: 4401, reason: "Access removed" });
  });

  it("keeps the connection record of a reload, whatever order the close and the join land in", async () => {
    const { fileId, teamId } = await newFile();
    const lena = await signedInUser("Lena", "editor", teamId);
    const rows = () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM room_connections WHERE file_id = ? AND user_id = ?")
        .bind(fileId, lena.userId)
        .first<{ n: number }>()
        .then((r) => r?.n ?? 0);
    for (let i = 0; i < 5; i++) {
      const first = await join(lena.browser, fileId, `reload${i}`);
      first.ws.close();
      await join(lena.browser, fileId, `reload${i}b`);
      // The old socket's close never takes the new one's record with it.
      await new Promise((r) => setTimeout(r, 30));
      expect(await rows()).toBe(1);
    }
  });

  it("answers malformed messages without dropping the socket", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    a.ws.send("not json");
    expect(await a.next("error")).toMatchObject({ code: "bad_message" });
    a.send({ t: "ping" });
    await a.next("pong");
  });
});
