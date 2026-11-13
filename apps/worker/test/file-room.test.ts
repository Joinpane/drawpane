import { env } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
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
  socket.send({ t: "hello", protocol: 1, clientId, revn });
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

  it("answers malformed messages without dropping the socket", async () => {
    const { browser, fileId } = await newFile();
    const a = await join(browser, fileId, "clientA");
    a.ws.send("not json");
    expect(await a.next("error")).toMatchObject({ code: "bad_message" });
    a.send({ t: "ping" });
    await a.next("pong");
  });
});
